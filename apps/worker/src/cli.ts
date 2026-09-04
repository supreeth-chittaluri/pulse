/**
 * Worker CLI.
 *
 *   npm run worker -- list-sources
 *   npm run worker -- fetch-once --source reddit:wallstreetbets   (print only)
 *   npm run worker -- ingest-once                                 (all sources -> Postgres)
 *   npm run worker -- run                                         (scheduled loop)
 *   npm run worker -- status                                      (last run per source)
 */
import { parseArgs } from 'node:util';
import {
  countPosts,
  countPostsBySource,
  createLogger,
  createPool,
  lastRunPerSource,
  loadConfig,
  type Config,
  type Logger,
  type Pool,
} from '@pulse/core';
import { buildSources, MinIntervalGate, type Source } from '@pulse/sources';
import { ingestSource } from './ingest.ts';
import { runScheduler } from './scheduler.ts';

const USAGE = `
pulse worker

Commands:
  list-sources                Show every configured source and its adapter
  fetch-once --source <id>    Fetch one source and print it (writes nothing)
  ingest-once                 Fetch every source once and write to Postgres
  run                         Poll every source on its schedule until stopped
  status                      Show stored post counts and the last run per source

Options:
  --source <id>   Source id from config/sources.json
  --limit <n>     fetch-once: print at most n posts
  --json          fetch-once: print raw JSON
  --help          Show this message
`.trim();

/**
 * Reddit's .rss limiter is per client across ALL feeds at roughly one request
 * per minute. Every Reddit adapter shares the "reddit" bucket and queues behind
 * this interval; see MinIntervalGate.
 */
const REDDIT_MIN_INTERVAL_MS = 60_000;

function truncate(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function findSource(sources: Source[], id: string | undefined): Source {
  if (!id) {
    throw new Error(`--source is required\n\n${USAGE}`);
  }
  const source = sources.find((s) => s.id === id);
  if (!source) {
    throw new Error(
      `No enabled source with id "${id}".\nKnown: ${sources.map((s) => s.id).join(', ')}`,
    );
  }
  return source;
}

function listSources(config: Config, sources: Source[]): number {
  console.log(`${sources.length} enabled source(s):\n`);
  for (const source of sources) {
    const bucket = source.rateLimitBucket ? `bucket:${source.rateLimitBucket}` : 'unlimited';
    console.log(
      `  ${source.id.padEnd(26)} ${source.adapter.padEnd(18)} every ${String(source.pollSeconds).padStart(4)}s  ${bucket}`,
    );
  }
  if (!config.redditOAuthEnabled) {
    console.log(
      '\nReddit is using the public .rss adapter. Set REDDIT_CLIENT_ID and' +
        '\nREDDIT_CLIENT_SECRET in .env to switch to OAuth.',
    );
  }
  return 0;
}

async function fetchOnce(
  sources: Source[],
  values: { source?: string; limit?: string; json?: boolean },
): Promise<number> {
  const source = findSource(sources, values.source);

  const startedAt = Date.now();
  const posts = await source.fetch();
  const elapsedMs = Date.now() - startedAt;

  const limit = values.limit ? Number.parseInt(values.limit, 10) : posts.length;
  if (Number.isNaN(limit) || limit < 0) {
    throw new Error(`--limit must be a non-negative integer, got "${values.limit}"`);
  }
  const shown = posts.slice(0, limit);

  if (values.json) {
    console.log(JSON.stringify(shown, null, 2));
    return 0;
  }

  console.log(
    `\n${source.id}  [${source.adapter}]  ${posts.length} post(s) in ${elapsedMs}ms` +
      `${shown.length < posts.length ? `, showing ${shown.length}` : ''}\n`,
  );

  for (const [index, post] of shown.entries()) {
    const when = post.postedAt ? post.postedAt.toISOString() : 'unknown time';
    console.log(`${String(index + 1).padStart(3)}. ${truncate(post.title, 96)}`);
    console.log(`     ${post.sourcePostId}  ${post.author ? `u/${post.author}` : 'no author'}  ${when}`);
    console.log(`     ${post.url}`);
    if (post.body) console.log(`     ${truncate(post.body, 140)}`);
    console.log('');
  }

  if (posts.length === 0) {
    console.log('  (feed returned no entries -- check the source id and network access)\n');
  }
  console.log('Nothing was written to Postgres. Use `ingest-once` for that.\n');
  return 0;
}

/**
 * One pass over every source. This is the command that proves dedupe: run it
 * twice and the second pass inserts zero.
 */
async function ingestOnce(pool: Pool, sources: Source[], logger: Logger): Promise<number> {
  const gate = new MinIntervalGate(REDDIT_MIN_INTERVAL_MS);
  const before = await countPosts(pool);

  let fetched = 0;
  let inserted = 0;
  let failed = 0;

  for (const source of sources) {
    try {
      const result = await ingestSource({ pool, gate, logger }, source);
      fetched += result.fetched;
      inserted += result.inserted;
    } catch {
      // ingestSource has already logged and recorded the failure. One bad
      // source must not abort the pass.
      failed += 1;
    }
  }

  const after = await countPosts(pool);
  console.log(
    `\nfetched ${fetched}, inserted ${inserted}, duplicates skipped ${fetched - inserted}` +
      `${failed > 0 ? `, sources failed ${failed}` : ''}`,
  );
  console.log(`posts table: ${before} -> ${after}\n`);

  return failed === sources.length ? 1 : 0;
}

async function run(pool: Pool, sources: Source[], logger: Logger): Promise<number> {
  const gate = new MinIntervalGate(REDDIT_MIN_INTERVAL_MS);
  const controller = new AbortController();

  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (stopping) {
        logger.warn('second signal; exiting immediately', { signal });
        process.exit(130);
      }
      stopping = true;
      logger.info('stopping after the current fetch', { signal });
      controller.abort();
    });
  }

  await runScheduler({
    sources,
    logger,
    signal: controller.signal,
    runImmediately: true,
    run: (source) => ingestSource({ pool, gate, logger }, source),
  });

  return 0;
}

async function status(pool: Pool): Promise<number> {
  const total = await countPosts(pool);
  const bySource = await countPostsBySource(pool);
  const runs = await lastRunPerSource(pool);
  const runBySource = new Map(runs.map((r) => [r.source, r]));

  console.log(`\nposts stored: ${total}\n`);
  if (bySource.length === 0) {
    console.log('  (nothing ingested yet -- try `ingest-once`)\n');
    return 0;
  }

  for (const { source, count } of bySource) {
    const last = runBySource.get(source);
    const when = last ? last.startedAt.toISOString() : 'never';
    const outcome = !last ? '' : last.error ? `  FAILED: ${truncate(last.error, 60)}` : '';
    console.log(`  ${source.padEnd(26)} ${String(count).padStart(6)} posts   last run ${when}${outcome}`);
  }

  // A source that has never succeeded has no posts row, so it would otherwise
  // be invisible here -- exactly the case worth surfacing.
  for (const last of runs) {
    if (!bySource.some((s) => s.source === last.source)) {
      const outcome = last.error ? `FAILED: ${truncate(last.error, 60)}` : 'no posts';
      console.log(
        `  ${last.source.padEnd(26)} ${'0'.padStart(6)} posts   last run ${last.startedAt.toISOString()}  ${outcome}`,
      );
    }
  }
  console.log('');
  return 0;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      source: { type: 'string' },
      limit: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });

  const command = positionals[0];
  if (values.help || !command) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }

  const config = loadConfig();
  const sources = buildSources(config);

  if (command === 'list-sources') return listSources(config, sources);
  if (command === 'fetch-once') return await fetchOnce(sources, values);

  if (command !== 'ingest-once' && command !== 'run' && command !== 'status') {
    console.error(`Unknown command: ${command}\n\n${USAGE}`);
    return 1;
  }

  // Commands past this point touch Postgres.
  const logger = createLogger('worker');
  const pool = createPool(config.databaseUrl);
  try {
    if (command === 'ingest-once') return await ingestOnce(pool, sources, logger);
    if (command === 'run') return await run(pool, sources, logger);
    return await status(pool);
  } finally {
    await pool.end();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const message = (err as Error).message;
    console.error(`\n${message}\n`);
    if (message.includes('HTTP 429')) {
      console.error(
        'Reddit rate-limits .rss per client across all feeds, at roughly one\n' +
          'request per minute. Wait a minute before fetching another subreddit.\n',
      );
    }
    if (process.env.DEBUG) console.error(err);
    process.exit(1);
  });

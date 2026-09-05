/**
 * Worker CLI.
 *
 *   npm run worker -- list-sources
 *   npm run worker -- fetch-once --source reddit:wallstreetbets   (print only)
 *   npm run worker -- ingest-once                                 (all sources -> Postgres)
 *   npm run worker -- run                                         (scheduled loop)
 *   npm run worker -- status                                      (last run per source)
 *   npm run worker -- score-once --dry-run                        (cost/quota preview)
 *   npm run worker -- score-once --limit 60                       (send to Gemini)
 *   npm run worker -- detect-spikes                               (free, no API)
 *   npm run worker -- alerts --dry-run                            (render, send nothing)
 *   npm run worker -- alerts                                      (SENDS SMS, costs money)
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
import { buildSources, MinIntervalGate, systemClock, type Source } from '@pulse/sources';
import {
  createGeminiModel,
  scorePendingPosts,
  GEMINI_RATE_LIMIT_BUCKET,
} from '@pulse/scoring';
import { HOUR_MS, latestCompleteWindow } from '@pulse/analysis';
import { createTwilioNotifier, sendPendingAlerts } from '@pulse/alerting';
import { runBackgroundLoops, REDDIT_MIN_INTERVAL_MS } from './loops.ts';
import { detectSpikes } from './spikes.ts';
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
  score-once                  Score pending posts with Gemini (on demand only)
  detect-spikes               Recompute baselines and flag spikes (free)
  alerts                      Send SMS for pending spikes (COSTS MONEY)

Options:
  --source <id>   Source id from config/sources.json
  --limit <n>     fetch-once: print at most n posts
                  score-once: pull at most n posts off the queue (default 60)
  --batch-size    score-once: posts per model request (default SCORING_BATCH_SIZE)
  --dry-run       score-once: report what would be sent, call nothing
                  detect-spikes: compute baselines, record no spikes
  --window        detect-spikes: hours back to test (default: last full hour)
                  alerts: --dry-run renders messages without sending
  --json          fetch-once: print raw JSON
  --help          Show this message
`.trim();

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

async function run(
  config: Config,
  pool: Pool,
  sources: Source[],
  logger: Logger,
): Promise<number> {
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

  // The loops live in loops.ts so the API can run the same ones in-process;
  // see DEPLOY.md for why a $0 deployment needs that.
  await runBackgroundLoops({ config, pool, logger, signal: controller.signal, sources });
  return 0;
}

/**
 * On-demand scoring. Deliberately NOT part of the scheduled loop: the Gemini
 * free tier is a fixed daily request quota, so recurring spend of it should be
 * an explicit act.
 */
async function scoreOnce(
  config: Config,
  pool: Pool,
  logger: Logger,
  values: { limit?: string; 'batch-size'?: string; 'dry-run'?: boolean },
): Promise<number> {
  const limit = values.limit ? Number.parseInt(values.limit, 10) : 60;
  const batchSize = values['batch-size']
    ? Number.parseInt(values['batch-size'], 10)
    : config.scoring.batchSize;
  const dryRun = values['dry-run'] ?? false;

  if (Number.isNaN(limit) || limit <= 0) throw new Error('--limit must be a positive integer');
  if (Number.isNaN(batchSize) || batchSize <= 0) {
    throw new Error('--batch-size must be a positive integer');
  }

  if (!dryRun && !config.gemini.apiKey) {
    throw new Error(
      'GEMINI_API_KEY is not set.\n' +
        'Get a free key (no card) at https://aistudio.google.com/apikey, put it in\n' +
        '.env, and keep billing OFF on that project -- enabling billing removes the\n' +
        'free tier entirely. Use --dry-run to preview without a key.',
    );
  }

  // Built only for a real run. Constructing the SDK client in dry-run mode
  // would warn about the missing key for a call we are never going to make.
  const model = dryRun
    ? {
        provider: 'gemini',
        model: config.gemini.model,
        generate: () => {
          throw new Error('dry run must not call the model');
        },
      }
    : createGeminiModel({ apiKey: config.gemini.apiKey!, model: config.gemini.model });
  const gate = new MinIntervalGate(config.gemini.minIntervalMs);

  const summary = await scorePendingPosts(
    { pool, model, gate, logger },
    { limit, batchSize, dailyRequestBudget: config.gemini.dailyRequestBudget, dryRun },
  );

  console.log('');
  if (dryRun) {
    console.log(`DRY RUN -- nothing was sent to ${config.gemini.model}.\n`);
  }
  console.log(`  posts considered        ${summary.postsConsidered}`);
  console.log(`  no ticker candidates    ${summary.skippedNoCandidates}  (scored free, 0 quota)`);
  console.log(`  posts needing the model ${summary.postsSent}`);
  console.log(`  requests ${dryRun ? 'required' : 'made'}        ${summary.requestsMade}  (batch size ${batchSize})`);
  if (!dryRun) {
    console.log(`  posts scored            ${summary.postsScored}`);
    console.log(`  signals written         ${summary.signalsWritten}`);
    console.log(`  tokens in/out           ${summary.inputTokens} / ${summary.outputTokens}`);
    if (summary.failures > 0) console.log(`  failures                ${summary.failures}`);
  }
  console.log(`  daily budget left       ${summary.requestsRemainingToday} of ${config.gemini.dailyRequestBudget}`);

  if (summary.stoppedEarly) {
    console.log(`\n  STOPPED EARLY: ${summary.stoppedEarly}`);
  }
  console.log('');
  return summary.failures > 0 && summary.postsScored === 0 ? 1 : 0;
}

/**
 * Spike detection. Costs nothing and calls no external service, so unlike
 * scoring this is safe to run on a schedule -- see runScheduler wiring.
 */
async function detectSpikesCommand(
  pool: Pool,
  logger: Logger,
  values: { window?: string; 'dry-run'?: boolean },
): Promise<number> {
  let windowStart: number | undefined;
  if (values.window) {
    const hoursBack = Number.parseInt(values.window, 10);
    if (Number.isNaN(hoursBack) || hoursBack < 0) {
      throw new Error('--window must be a non-negative number of hours back');
    }
    windowStart = latestCompleteWindow() - hoursBack * HOUR_MS;
  }

  const summary = await detectSpikes(
    { pool, logger },
    { windowStart, dryRun: values['dry-run'] ?? false },
  );

  console.log('');
  console.log(`  window tested       ${new Date(summary.windowStart).toISOString()}`);
  console.log(`  tickers considered  ${summary.tickersConsidered}`);
  console.log(`  baselines written   ${summary.baselinesWritten}`);
  console.log(`  spikes detected     ${summary.spikes.length}${values['dry-run'] ? ' (dry run, not recorded)' : ` (${summary.recorded} new)`}`);
  console.log('');
  console.log('  not flagged because:');
  for (const [reason, count] of Object.entries(summary.rejections)) {
    if (count > 0) console.log(`    ${reason.padEnd(22)} ${count}`);
  }

  if (summary.spikes.length > 0) {
    console.log('');
    for (const spike of summary.spikes) {
      const sentiment =
        spike.sentimentZ === null ? '   n/a' : spike.sentimentZ.toFixed(2).padStart(6);
      console.log(
        `    ${spike.tickerOrTopic.padEnd(6)} ${String(spike.mentionCount).padStart(4)} mentions ` +
          `(baseline ${spike.baselineAvgVolume.toFixed(2)}/hr)  ` +
          `volume z ${spike.volumeZ.toFixed(2).padStart(6)}  sentiment z ${sentiment}  ${spike.kind}`,
      );
    }
  }
  console.log('');
  return 0;
}

/**
 * SMS alerting. The only command in the project that spends money per call.
 *
 * Off unless ALERTS_ENABLED=true, and even then bounded by a per-ticker
 * cooldown, a spike-age cutoff, and a rolling daily budget.
 */
async function alertsCommand(
  config: Config,
  pool: Pool,
  logger: Logger,
  values: { 'dry-run'?: boolean },
): Promise<number> {
  const dryRun = values['dry-run'] ?? false;

  // A dry run needs no credentials and no opt-in: it renders messages and
  // sends nothing, which is exactly what you want before wiring up Twilio.
  if (!dryRun) {
    if (!config.alerts.configured) {
      throw new Error(
        'Twilio is not configured.\n' +
          'Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER and\n' +
          'TWILIO_TO_NUMBER in .env. Use --dry-run to preview without credentials.',
      );
    }
    if (!config.alerts.enabled) {
      throw new Error(
        'Alerting is disabled. Set ALERTS_ENABLED=true in .env to send real SMS.\n' +
          'This costs roughly $0.008 per message plus the monthly number fee.',
      );
    }
  }

  const notifier = dryRun
    ? {
        channel: 'sms' as const,
        from: config.alerts.twilio.from ?? 'unconfigured',
        send: () => {
          throw new Error('dry run must not send');
        },
      }
    : createTwilioNotifier({
        accountSid: config.alerts.twilio.accountSid!,
        authToken: config.alerts.twilio.authToken!,
        from: config.alerts.twilio.from!,
      });

  const summary = await sendPendingAlerts(
    { pool, notifier, logger, to: config.alerts.twilio.to ?? '+10000000000' },
    {
      kind: config.alerts.kind,
      cooldownHours: config.alerts.cooldownHours,
      dailyBudget: config.alerts.dailyBudget,
      maxSpikeAgeHours: config.alerts.maxSpikeAgeHours,
    },
    { dryRun },
  );

  console.log('');
  if (dryRun) console.log('DRY RUN -- no SMS was sent.\n');
  console.log(`  spikes considered   ${summary.considered}`);
  console.log(`  would send          ${summary.bodies.length}`);
  if (!dryRun) {
    console.log(`  sent                ${summary.sent}`);
    if (summary.failed > 0) console.log(`  failed              ${summary.failed}`);
  }
  const skipped = Object.entries(summary.skipped).filter(([, n]) => n > 0);
  if (skipped.length > 0) {
    console.log('  skipped:');
    for (const [reason, count] of skipped) console.log(`    ${reason.padEnd(14)} ${count}`);
  }
  for (const body of summary.bodies) console.log(`\n    "${body}"`);
  console.log('');
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
      'batch-size': { type: 'string' },
      window: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
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

  const dbCommands = new Set([
    'ingest-once', 'run', 'status', 'score-once', 'detect-spikes', 'alerts',
  ]);
  if (!dbCommands.has(command)) {
    console.error(`Unknown command: ${command}\n\n${USAGE}`);
    return 1;
  }

  // Commands past this point touch Postgres.
  const logger = createLogger('worker');
  const pool = createPool(config.databaseUrl);
  try {
    if (command === 'ingest-once') return await ingestOnce(pool, sources, logger);
    if (command === 'run') return await run(config, pool, sources, logger);
    if (command === 'score-once') return await scoreOnce(config, pool, logger, values);
    if (command === 'detect-spikes') return await detectSpikesCommand(pool, logger, values);
    if (command === 'alerts') return await alertsCommand(config, pool, logger, values);
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

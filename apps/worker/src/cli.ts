/**
 * Worker CLI.
 *
 *   npm run worker -- list-sources
 *   npm run worker -- fetch-once --source reddit:wallstreetbets
 *   npm run worker -- fetch-once --source reddit:stocks --limit 5 --json
 *
 * M0 scope: fetch and PRINT only. Nothing is written to Postgres -- that is
 * M1, along with dedupe and scheduling.
 */
import { parseArgs } from 'node:util';
import { loadConfig } from '@pulse/core';
import { buildSources } from '@pulse/sources';

const USAGE = `
pulse worker

Commands:
  list-sources                      Show every configured source and its adapter
  fetch-once --source <id>          Fetch one source and print the posts

Options:
  --source <id>   Source id from config/sources.json (required for fetch-once)
  --limit <n>     Print at most n posts (default: all)
  --json          Print raw JSON instead of the human-readable summary
  --help          Show this message
`.trim();

function truncate(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
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

  if (command === 'list-sources') {
    console.log(`${sources.length} enabled source(s):\n`);
    for (const source of sources) {
      console.log(`  ${source.id.padEnd(26)} ${source.adapter.padEnd(18)} every ${source.pollSeconds}s`);
    }
    if (!config.redditOAuthEnabled) {
      console.log(
        '\nReddit is using the public .rss adapter. Set REDDIT_CLIENT_ID and' +
          '\nREDDIT_CLIENT_SECRET in .env to switch to OAuth.',
      );
    }
    return 0;
  }

  if (command !== 'fetch-once') {
    console.error(`Unknown command: ${command}\n\n${USAGE}`);
    return 1;
  }

  if (!values.source) {
    console.error(`fetch-once requires --source\n\n${USAGE}`);
    return 1;
  }

  const source = sources.find((s) => s.id === values.source);
  if (!source) {
    console.error(
      `No enabled source with id "${values.source}".\n` +
        `Known: ${sources.map((s) => s.id).join(', ')}`,
    );
    return 1;
  }

  const startedAt = Date.now();
  const posts = await source.fetch();
  const elapsedMs = Date.now() - startedAt;

  const limit = values.limit ? Number.parseInt(values.limit, 10) : posts.length;
  if (Number.isNaN(limit) || limit < 0) {
    console.error(`--limit must be a non-negative integer, got "${values.limit}"`);
    return 1;
  }
  const shown = posts.slice(0, limit);

  if (values.json) {
    console.log(JSON.stringify(shown, null, 2));
    return 0;
  }

  console.log(
    `\n${source.id}  [${source.adapter}]  ` +
      `${posts.length} post(s) in ${elapsedMs}ms` +
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
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const message = (err as Error).message;
    console.error(`\nfetch failed: ${message}\n`);
    if (message.includes('HTTP 429')) {
      console.error(
        'Reddit rate-limits .rss per client across all feeds, at roughly one\n' +
          'request per minute. Wait a minute before fetching another subreddit.\n',
      );
    }
    if (process.env.DEBUG) console.error(err);
    process.exit(1);
  });

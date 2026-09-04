import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  countPosts,
  createPool,
  insertPosts,
  lastRunPerSource,
  type Logger,
  type Pool,
  type RawPost,
} from '@pulse/core';
import { MinIntervalGate, type Source } from '@pulse/sources';
import { runMigrations } from '../../../db/migrate.ts';
import { ingestSource } from './ingest.ts';

/**
 * These run against a real throwaway Postgres database rather than a mock.
 * The thing under test IS the posts_source_post_unique constraint, so mocking
 * it away would leave the M1 acceptance criterion untested.
 *
 * Requires `npm run db:up`. Skips loudly if Postgres is unreachable.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

try {
  process.loadEnvFile(resolve(repoRoot, '.env'));
} catch {
  // Fall through to the docker-compose defaults below.
}

const baseUrl = process.env.DATABASE_URL ?? 'postgres://pulse:pulse@localhost:5433/pulse';

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

const TEST_DATABASE = 'pulse_test';

let pool: Pool | undefined;
let skipReason: string | null = null;

try {
  const admin = createPool(withDatabase(baseUrl, 'postgres'));
  try {
    // `with (force)` drops lingering connections from a previous aborted run.
    await admin.query(`drop database if exists ${TEST_DATABASE} with (force)`);
    await admin.query(`create database ${TEST_DATABASE}`);
  } finally {
    await admin.end();
  }
  pool = createPool(withDatabase(baseUrl, TEST_DATABASE));
  await runMigrations(pool, { dir: resolve(repoRoot, 'db'), quiet: true });
} catch (err) {
  skipReason = (err as Error).message;
  console.warn(
    `\n  SKIPPING database tests -- Postgres unreachable at ${baseUrl}\n` +
      `  ${skipReason}\n  Run \`npm run db:up\` first.\n`,
  );
}

afterAll(async () => {
  await pool?.end();
});

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function post(overrides: Partial<RawPost> = {}): RawPost {
  return {
    source: 'reddit:test',
    sourcePostId: 't3_aaa',
    title: 'NVDA earnings play',
    body: 'calls printing',
    url: 'https://example.com/a',
    author: 'someone',
    postedAt: new Date('2026-09-04T12:00:00Z'),
    ...overrides,
  };
}

function fakeSource(posts: RawPost[] | (() => Promise<RawPost[]>)): Source {
  return {
    id: 'reddit:test',
    adapter: 'reddit-rss',
    pollSeconds: 600,
    rateLimitBucket: 'reddit',
    fetch: typeof posts === 'function' ? posts : async () => posts,
  };
}

function deps(db: Pool) {
  return { pool: db, gate: new MinIntervalGate(0), logger: silentLogger };
}

describe.skipIf(skipReason !== null)('insertPosts', () => {
  beforeEach(async () => {
    await pool!.query('truncate posts, signals, ingest_runs restart identity cascade');
  });

  it('inserts new posts and returns their ids', async () => {
    const result = await insertPosts(pool!, [
      post({ sourcePostId: 't3_a' }),
      post({ sourcePostId: 't3_b' }),
    ]);

    expect(result).toMatchObject({ offered: 2, inserted: 2 });
    expect(result.insertedIds).toHaveLength(2);
    expect(await countPosts(pool!)).toBe(2);
  });

  // The M1 acceptance criterion.
  it('inserts nothing on a second identical batch', async () => {
    const batch = [post({ sourcePostId: 't3_a' }), post({ sourcePostId: 't3_b' })];

    const first = await insertPosts(pool!, batch);
    const second = await insertPosts(pool!, batch);

    expect(first.inserted).toBe(2);
    expect(second.inserted).toBe(0);
    expect(second.offered).toBe(2);
    expect(await countPosts(pool!)).toBe(2);
  });

  it('inserts only the genuinely new posts in an overlapping batch', async () => {
    await insertPosts(pool!, [post({ sourcePostId: 't3_a' }), post({ sourcePostId: 't3_b' })]);
    const result = await insertPosts(pool!, [
      post({ sourcePostId: 't3_b' }),
      post({ sourcePostId: 't3_c' }),
    ]);

    expect(result.inserted).toBe(1);
    expect(await countPosts(pool!)).toBe(3);
  });

  it('collapses duplicates inside a single batch', async () => {
    const result = await insertPosts(pool!, [
      post({ sourcePostId: 't3_a' }),
      post({ sourcePostId: 't3_a' }),
      post({ sourcePostId: 't3_a' }),
    ]);

    expect(result.offered).toBe(1);
    expect(result.inserted).toBe(1);
    expect(await countPosts(pool!)).toBe(1);
  });

  it('keeps the same post id under two different sources', async () => {
    // Two subreddits can carry the same crosspost; they are separate rows.
    const result = await insertPosts(pool!, [
      post({ source: 'reddit:stocks', sourcePostId: 't3_a' }),
      post({ source: 'reddit:investing', sourcePostId: 't3_a' }),
    ]);

    expect(result.inserted).toBe(2);
  });

  it('handles an empty batch without touching the database', async () => {
    expect(await insertPosts(pool!, [])).toEqual({ offered: 0, inserted: 0, insertedIds: [] });
  });

  it('round-trips nullable fields', async () => {
    await insertPosts(pool!, [post({ body: null, author: null, postedAt: null })]);

    const { rows } = await pool!.query('select body, author, posted_at from posts');
    expect(rows[0]).toEqual({ body: null, author: null, posted_at: null });
  });

  it('writes more rows than a single statement chunk', async () => {
    const many = Array.from({ length: 1200 }, (_, i) => post({ sourcePostId: `t3_${i}` }));
    const result = await insertPosts(pool!, many);

    expect(result.inserted).toBe(1200);
    expect(await countPosts(pool!)).toBe(1200);
  });
});

describe.skipIf(skipReason !== null)('ingestSource', () => {
  beforeEach(async () => {
    await pool!.query('truncate posts, signals, ingest_runs restart identity cascade');
  });

  it('fetches, stores, and records the run', async () => {
    const source = fakeSource([post({ sourcePostId: 't3_a' }), post({ sourcePostId: 't3_b' })]);

    const result = await ingestSource(deps(pool!), source);

    expect(result).toMatchObject({ source: 'reddit:test', fetched: 2, inserted: 2 });
    const [run] = await lastRunPerSource(pool!);
    expect(run).toMatchObject({
      source: 'reddit:test',
      adapter: 'reddit-rss',
      postsFetched: 2,
      postsInserted: 2,
      error: null,
    });
    expect(run?.finishedAt).toBeInstanceOf(Date);
  });

  // The M1 acceptance criterion, through the real ingest path.
  it('creates no duplicate rows when run twice in a row', async () => {
    const source = fakeSource([post({ sourcePostId: 't3_a' }), post({ sourcePostId: 't3_b' })]);

    const first = await ingestSource(deps(pool!), source);
    const second = await ingestSource(deps(pool!), source);

    expect(first.inserted).toBe(2);
    expect(second.fetched).toBe(2);
    expect(second.inserted).toBe(0);
    expect(await countPosts(pool!)).toBe(2);
  });

  it('records a failed run and rethrows so the scheduler can back off', async () => {
    const source = fakeSource(async () => {
      throw new Error('HTTP 429 for https://reddit.com/...');
    });

    await expect(ingestSource(deps(pool!), source)).rejects.toThrow('HTTP 429');

    const [run] = await lastRunPerSource(pool!);
    expect(run?.error).toContain('HTTP 429');
    expect(run?.postsInserted).toBe(0);
    expect(run?.finishedAt).toBeInstanceOf(Date);
  });

  it('truncates a huge error message instead of bloating the table', async () => {
    const source = fakeSource(async () => {
      throw new Error('x'.repeat(50_000));
    });

    await expect(ingestSource(deps(pool!), source)).rejects.toThrow();

    const [run] = await lastRunPerSource(pool!);
    expect(run?.error?.length).toBe(1000);
  });

  it('waits on the rate-limit gate before fetching', async () => {
    const gate = new MinIntervalGate(60_000, {
      now: () => 0,
      sleep: async () => {},
    });
    const source = fakeSource([post({ sourcePostId: 't3_a' })]);

    await ingestSource({ pool: pool!, gate, logger: silentLogger }, source);
    // The Reddit bucket is now held, so the next Reddit fetch would have to wait.
    expect(gate.waitTimeMs('reddit')).toBe(60_000);
    expect(gate.waitTimeMs(null)).toBe(0);
  });
});

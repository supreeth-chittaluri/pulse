import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  countRequestsToday,
  countSignals,
  createPool,
  insertPosts,
  type Logger,
  type Pool,
  type RawPost,
} from '@pulse/core';
import { MinIntervalGate } from '@pulse/sources';
import { runMigrations } from '../../../db/migrate.ts';
import { scorePendingPosts } from './score.ts';
import { QuotaExceededError, type GenerateResult, type ScoringModel } from './gemini.ts';

/**
 * Real Postgres, fake model. The database half must be real because the
 * transaction boundary and the unique constraint are what these tests are
 * about; the model half must be fake because the free tier is a finite daily
 * quota and `npm test` must never consume it.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
try {
  process.loadEnvFile(resolve(repoRoot, '.env'));
} catch {
  /* docker-compose defaults below */
}

const baseUrl = process.env.DATABASE_URL ?? 'postgres://pulse:pulse@localhost:5433/pulse';
const TEST_DATABASE = 'pulse_scoring_test';

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

let pool: Pool | undefined;
let skipReason: string | null = null;

try {
  const admin = createPool(withDatabase(baseUrl, 'postgres'));
  try {
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
    `\n  SKIPPING scoring database tests -- Postgres unreachable at ${baseUrl}\n` +
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

/** A model that returns whatever the test tells it to, recording its prompts. */
function fakeModel(
  handler: (userPrompt: string, call: number) => GenerateResult | Promise<GenerateResult>,
): ScoringModel & { calls: string[] } {
  const calls: string[] = [];
  return {
    provider: 'gemini',
    model: 'fake-flash',
    calls,
    async generate(_system: string, userPrompt: string) {
      calls.push(userPrompt);
      return handler(userPrompt, calls.length);
    },
  };
}

function ok(results: unknown): GenerateResult {
  return {
    text: JSON.stringify({ results }),
    inputTokens: 100,
    outputTokens: 50,
    durationMs: 10,
  };
}

function post(overrides: Partial<RawPost> = {}): RawPost {
  return {
    source: 'reddit:test',
    sourcePostId: `t3_${Math.random().toString(36).slice(2)}`,
    title: 'NVDA earnings play',
    body: 'loading calls',
    url: 'https://example.com/a',
    author: 'someone',
    postedAt: new Date('2026-09-04T12:00:00Z'),
    ...overrides,
  };
}

async function seed(posts: RawPost[]): Promise<number[]> {
  const { insertedIds } = await insertPosts(pool!, posts);
  return insertedIds;
}

function deps(model: ScoringModel) {
  return { pool: pool!, model, gate: new MinIntervalGate(0), logger: silentLogger };
}

const OPTIONS = { limit: 100, batchSize: 10, dailyRequestBudget: 100 };

describe.skipIf(skipReason !== null)('scorePendingPosts', () => {
  beforeEach(async () => {
    await pool!.query('truncate posts, signals, llm_requests restart identity cascade');
  });

  it('scores a post and writes its signals', async () => {
    const [id] = await seed([post({ title: '$NVDA to the moon' })]);
    const model = fakeModel(() =>
      ok([
        {
          post_id: id,
          tickers: [
            {
              ticker: 'NVDA',
              is_ticker_mention: true,
              sentiment_score: 0.9,
              confidence: 0.8,
              rationale: 'bullish',
            },
          ],
        },
      ]),
    );

    const summary = await scorePendingPosts(deps(model), OPTIONS);

    expect(summary).toMatchObject({ postsScored: 1, signalsWritten: 1, requestsMade: 1 });
    const { rows } = await pool!.query(
      'select ticker_or_topic, sentiment_score, confidence from signals',
    );
    expect(rows[0]).toMatchObject({ ticker_or_topic: 'NVDA', sentiment_score: 0.9 });
  });

  // The free half: most of the queue never reaches the model at all.
  it('marks a post with no ticker candidates as scored without calling the model', async () => {
    await seed([post({ title: 'Show HN: a static site generator', body: 'no tickers here' })]);
    const model = fakeModel(() => {
      throw new Error('model must not be called');
    });

    const summary = await scorePendingPosts(deps(model), OPTIONS);

    expect(summary).toMatchObject({ skippedNoCandidates: 1, postsSent: 0, requestsMade: 0 });
    expect(model.calls).toHaveLength(0);
    expect(await countSignals(pool!)).toBe(0);
    const { rows } = await pool!.query('select scored_at from posts');
    expect(rows[0]?.scored_at).toBeInstanceOf(Date);
  });

  it('does not re-score an already scored post', async () => {
    const [id] = await seed([post({ title: '$NVDA up' })]);
    const model = fakeModel(() =>
      ok([
        {
          post_id: id,
          tickers: [
            {
              ticker: 'NVDA',
              is_ticker_mention: true,
              sentiment_score: 0.5,
              confidence: 0.5,
              rationale: 'x',
            },
          ],
        },
      ]),
    );

    await scorePendingPosts(deps(model), OPTIONS);
    const second = await scorePendingPosts(deps(model), OPTIONS);

    expect(second.postsConsidered).toBe(0);
    expect(model.calls).toHaveLength(1);
    expect(await countSignals(pool!)).toBe(1);
  });

  it('drops a ticker the model invented', async () => {
    const [id] = await seed([post({ title: '$NVDA only' })]);
    const model = fakeModel(() =>
      ok([
        {
          post_id: id,
          tickers: [
            {
              ticker: 'NVDA',
              is_ticker_mention: true,
              sentiment_score: 0.5,
              confidence: 0.9,
              rationale: 'ok',
            },
            {
              // Never offered as a candidate -- a hallucination.
              ticker: 'TSLA',
              is_ticker_mention: true,
              sentiment_score: -0.9,
              confidence: 0.9,
              rationale: 'invented',
            },
          ],
        },
      ]),
    );

    const summary = await scorePendingPosts(deps(model), OPTIONS);

    expect(summary.signalsWritten).toBe(1);
    const { rows } = await pool!.query('select ticker_or_topic from signals');
    expect(rows.map((r) => r.ticker_or_topic)).toEqual(['NVDA']);
  });

  it('writes no signal when the model says it is not a ticker mention', async () => {
    const [id] = await seed([post({ title: '$DD is due diligence', body: 'not the chemical co' })]);
    const model = fakeModel(() =>
      ok([
        {
          post_id: id,
          tickers: [
            {
              ticker: 'DD',
              is_ticker_mention: false,
              sentiment_score: 0,
              confidence: 0.9,
              rationale: 'means due diligence',
            },
          ],
        },
      ]),
    );

    const summary = await scorePendingPosts(deps(model), OPTIONS);

    expect(summary.postsScored).toBe(1);
    expect(summary.signalsWritten).toBe(0);
  });

  it('retries individually when a batch response fails validation', async () => {
    const ids = await seed([
      post({ title: '$NVDA a' }),
      post({ title: '$TSLA b' }),
      post({ title: '$AMD c' }),
    ]);
    const verdict = (ticker: string) => ({
      ticker,
      is_ticker_mention: true,
      sentiment_score: 0.1,
      confidence: 0.5,
      rationale: 'x',
    });

    const model = fakeModel((prompt, call) => {
      // First call is the whole batch and comes back missing a post.
      if (call === 1) {
        return ok([{ post_id: ids[0], tickers: [verdict('NVDA')] }]);
      }
      const id = ids.find((i) => prompt.includes(`id="${i}"`))!;
      const ticker = prompt.includes('NVDA') ? 'NVDA' : prompt.includes('TSLA') ? 'TSLA' : 'AMD';
      return ok([{ post_id: id, tickers: [verdict(ticker)] }]);
    });

    const summary = await scorePendingPosts(deps(model), { ...OPTIONS, batchSize: 3 });

    // One bad batch response must not cost the other two posts their scoring.
    expect(summary.postsScored).toBe(3);
    expect(summary.requestsMade).toBe(4); // 1 failed batch + 3 singles
    expect(await countSignals(pool!)).toBe(3);
  });

  it('records a failure and increments attempts when a single post keeps failing', async () => {
    const [id] = await seed([post({ title: '$NVDA x' })]);
    const model = fakeModel(() => ({
      text: 'not json',
      inputTokens: 1,
      outputTokens: 1,
      durationMs: 1,
    }));

    const summary = await scorePendingPosts(deps(model), { ...OPTIONS, batchSize: 1 });

    expect(summary.failures).toBe(1);
    const { rows } = await pool!.query(
      'select score_attempts, score_error, scored_at from posts where id = $1',
      [id],
    );
    expect(rows[0]?.score_attempts).toBe(1);
    expect(rows[0]?.score_error).toBeTruthy();
    expect(rows[0]?.scored_at).toBeNull();
  });

  it('stops pulling a post that has failed too many times', async () => {
    const [id] = await seed([post({ title: '$NVDA x' })]);
    await pool!.query('update posts set score_attempts = 3 where id = $1', [id]);
    const model = fakeModel(() => {
      throw new Error('must not be called');
    });

    expect((await scorePendingPosts(deps(model), OPTIONS)).postsConsidered).toBe(0);
  });

  it('records every request for quota accounting', async () => {
    const [id] = await seed([post({ title: '$NVDA x' })]);
    const model = fakeModel(() => ok([{ post_id: id, tickers: [] }]));

    await scorePendingPosts(deps(model), OPTIONS);

    expect(await countRequestsToday(pool!, 'gemini')).toBe(1);
    const { rows } = await pool!.query(
      'select provider, model, posts_in_batch, input_tokens from llm_requests',
    );
    expect(rows[0]).toMatchObject({ provider: 'gemini', posts_in_batch: 1, input_tokens: 100 });
  });

  // The guard that keeps a free-tier project inside its daily quota.
  it('refuses to exceed the daily request budget', async () => {
    const ids = await seed([post({ title: '$NVDA a' }), post({ title: '$TSLA b' })]);
    const model = fakeModel((prompt) => {
      const id = ids.find((i) => prompt.includes(`id="${i}"`))!;
      return ok([{ post_id: id, tickers: [] }]);
    });

    const summary = await scorePendingPosts(deps(model), {
      ...OPTIONS,
      batchSize: 1,
      dailyRequestBudget: 1,
    });

    expect(summary.requestsMade).toBe(1);
    expect(summary.stoppedEarly).toMatch(/Daily request budget/);
    expect(summary.requestsRemainingToday).toBe(0);
  });

  it('counts requests already made today against the budget', async () => {
    await seed([post({ title: '$NVDA a' })]);
    await pool!.query(
      "insert into llm_requests (provider, model, posts_in_batch) values ('gemini', 'x', 1)",
    );
    const model = fakeModel(() => {
      throw new Error('must not be called');
    });

    const summary = await scorePendingPosts(deps(model), { ...OPTIONS, dailyRequestBudget: 1 });

    expect(summary.requestsMade).toBe(0);
    expect(summary.stoppedEarly).toMatch(/already used today/);
  });

  it('stops immediately when the provider reports quota exhaustion', async () => {
    const ids = await seed([post({ title: '$NVDA a' }), post({ title: '$TSLA b' })]);
    const model = fakeModel(() => {
      throw new QuotaExceededError('RESOURCE_EXHAUSTED');
    });

    const summary = await scorePendingPosts(deps(model), { ...OPTIONS, batchSize: 1 });

    expect(summary.stoppedEarly).toMatch(/RESOURCE_EXHAUSTED/);
    // Bailed after the first failure rather than burning the second request.
    expect(model.calls).toHaveLength(1);
    expect(ids).toHaveLength(2);
  });

  it('dry run calls nothing and writes nothing', async () => {
    await seed([post({ title: '$NVDA a' }), post({ title: 'no tickers here at all' })]);
    const model = fakeModel(() => {
      throw new Error('must not be called');
    });

    const summary = await scorePendingPosts(deps(model), { ...OPTIONS, batchSize: 1, dryRun: true });

    expect(summary).toMatchObject({ postsConsidered: 2, postsSent: 1, requestsMade: 1 });
    expect(model.calls).toHaveLength(0);
    expect(await countSignals(pool!)).toBe(0);
    const { rows } = await pool!.query('select count(*) from posts where scored_at is not null');
    expect(Number(rows[0]!.count)).toBe(0);
  });

  it('sends the post id and candidates in the prompt', async () => {
    const [id] = await seed([post({ title: '$NVDA and TSLA' })]);
    const model = fakeModel(() => ok([{ post_id: id, tickers: [] }]));

    await scorePendingPosts(deps(model), OPTIONS);

    expect(model.calls[0]).toContain(`id="${id}"`);
    expect(model.calls[0]).toContain('NVDA');
    expect(model.calls[0]).toContain('TSLA');
  });

  it('waits on the shared rate-limit gate between requests', async () => {
    const ids = await seed([post({ title: '$NVDA a' }), post({ title: '$TSLA b' })]);
    const sleep = vi.fn(async () => {});
    const gate = new MinIntervalGate(6_000, { now: () => 0, sleep });
    const model = fakeModel((prompt) => {
      const id = ids.find((i) => prompt.includes(`id="${i}"`))!;
      return ok([{ post_id: id, tickers: [] }]);
    });

    await scorePendingPosts(
      { pool: pool!, model, gate, logger: silentLogger },
      { ...OPTIONS, batchSize: 1 },
    );

    // Second request had to wait out the configured interval.
    expect(sleep).toHaveBeenCalledWith(6_000, undefined);
  });
});

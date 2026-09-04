import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, recentSpikes, type Logger, type Pool } from '@pulse/core';
import { DEFAULT_DETECTION_CONFIG, HOUR_MS } from '@pulse/analysis';
import { runMigrations } from '../../../db/migrate.ts';
import { detectSpikes } from './spikes.ts';

/**
 * Covers the database half of detection: baseline upserts, spike idempotency,
 * cooldown read back from the spikes table, and watchlist threshold overrides.
 * The formula itself is tested exhaustively and without I/O in @pulse/analysis.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
try {
  process.loadEnvFile(resolve(repoRoot, '.env'));
} catch {
  /* docker-compose defaults below */
}

const baseUrl = process.env.DATABASE_URL ?? 'postgres://pulse:pulse@localhost:5433/pulse';
const TEST_DATABASE = 'pulse_spikes_test';

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
  console.warn(`\n  SKIPPING spike database tests -- Postgres unreachable: ${skipReason}\n`);
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

const WINDOW_START = Date.UTC(2026, 8, 4, 12, 0, 0);

/**
 * Seeds `count` mentions of a ticker inside one hour.
 *
 * signals is unique on (post_id, ticker_or_topic), so N mentions of the same
 * ticker require N distinct posts -- which is also what really happens.
 */
async function seedSignals(options: {
  ticker: string;
  bucket: number;
  count: number;
  sentiment: number;
  source?: string;
}): Promise<void> {
  const { ticker, bucket, count, sentiment, source = 'reddit:stocks' } = options;

  for (let i = 0; i < count; i += 1) {
    const { rows } = await pool!.query<{ id: string }>(
      `insert into posts (source, source_post_id, title, url, scraped_at)
       values ($1, $2, $3, $4, to_timestamp($5 / 1000.0))
       returning id`,
      [
        source,
        `${ticker}-${bucket}-${i}`,
        `${ticker} post`,
        'https://example.com',
        bucket,
      ],
    );

    await pool!.query(
      `insert into signals
         (post_id, source, ticker_or_topic, sentiment_score, confidence, raw_excerpt, scraped_at)
       values ($1, $2, $3, $4, 0.9, 'x', to_timestamp($5 / 1000.0))`,
      [rows[0]!.id, source, ticker, sentiment, bucket],
    );
  }
}

/** Flat history of `perHour` mentions for 168 hours, then a surge in the window. */
async function seedTicker(options: {
  ticker: string;
  perHour: number;
  surge: number;
  sentiment?: number;
  surgeSentiment?: number;
  source?: string;
}): Promise<void> {
  const { ticker, perHour, surge, sentiment = 0.1, surgeSentiment, source } = options;
  for (let h = 168; h >= 1; h -= 1) {
    await seedSignals({
      ticker,
      bucket: WINDOW_START - h * HOUR_MS,
      count: perHour,
      sentiment,
      source,
    });
  }
  await seedSignals({
    ticker,
    bucket: WINDOW_START,
    count: surge,
    sentiment: surgeSentiment ?? sentiment,
    source,
  });
}

function run(overrides: Partial<typeof DEFAULT_DETECTION_CONFIG> = {}) {
  return detectSpikes(
    { pool: pool!, logger: silentLogger },
    { windowStart: WINDOW_START, config: { ...DEFAULT_DETECTION_CONFIG, ...overrides } },
  );
}

describe.skipIf(skipReason !== null)('detectSpikes (database)', () => {
  beforeEach(async () => {
    await pool!.query(
      'truncate posts, signals, spikes, baselines, watchlist restart identity cascade',
    );
  });

  it('detects and records a spike', async () => {
    await seedTicker({ ticker: 'NVDA', perHour: 2, surge: 40 });

    const summary = await run();

    expect(summary.spikes).toHaveLength(1);
    expect(summary.recorded).toBe(1);
    const [stored] = await recentSpikes(pool!);
    expect(stored).toMatchObject({ tickerOrTopic: 'NVDA', mentionCount: 40, kind: 'volume' });
    expect(Number(stored!.volumeZ)).toBeGreaterThan(3);
  });

  it('writes a baseline even for tickers that did not spike', async () => {
    await seedTicker({ ticker: 'AAPL', perHour: 3, surge: 3 });

    const summary = await run();

    expect(summary.spikes).toHaveLength(0);
    expect(summary.baselinesWritten).toBe(1);
    const { rows } = await pool!.query(
      'select rolling_avg, rolling_avg_volume, sample_count from baselines',
    );
    expect(Number(rows[0]!.rolling_avg_volume)).toBeCloseTo(3, 0);
    expect(Number(rows[0]!.sample_count)).toBeGreaterThan(20);
  });

  // Re-running detection over the same hour must not duplicate the spike.
  it('is idempotent across repeated runs of the same window', async () => {
    await seedTicker({ ticker: 'NVDA', perHour: 2, surge: 40 });

    const first = await run();
    // Cooldown would mask the duplicate, so disable it to test the constraint.
    const second = await run({ cooldownHours: 0 });

    expect(first.recorded).toBe(1);
    expect(second.spikes).toHaveLength(1);
    expect(second.recorded).toBe(0);
    expect(await recentSpikes(pool!)).toHaveLength(1);
  });

  it('suppresses a repeat inside the cooldown window', async () => {
    await seedTicker({ ticker: 'NVDA', perHour: 2, surge: 40 });
    await run();

    const again = await run();

    expect(again.spikes).toHaveLength(0);
    expect(again.rejections.cooldown).toBe(1);
  });

  it('applies a per-ticker threshold from the watchlist', async () => {
    await seedTicker({ ticker: 'NVDA', perHour: 10, surge: 22 });
    await pool!.query(
      "insert into watchlist (ticker_or_topic, alert_threshold) values ('NVDA', 99)",
    );

    expect((await run()).spikes).toHaveLength(0);

    await pool!.query("update watchlist set alert_threshold = 1 where ticker_or_topic = 'NVDA'");
    expect((await run()).spikes).toHaveLength(1);
  });

  it('classifies a surge with a sentiment shift', async () => {
    await seedTicker({
      ticker: 'LULU',
      perHour: 3,
      surge: 40,
      sentiment: 0.4,
      surgeSentiment: -0.7,
    });

    const [spike] = (await run()).spikes;

    expect(spike!.kind).toBe('volume+sentiment');
    expect(spike!.sentimentZ!).toBeLessThan(-3);
  });

  it('does not count fixed-cadence news feeds toward volume', async () => {
    await seedTicker({ ticker: 'TSLA', perHour: 2, surge: 3 });
    // A news feed adding a steady stream must not push TSLA over the floor.
    await seedTicker({ ticker: 'TSLA', perHour: 6, surge: 6, source: 'news:TSLA' });

    const summary = await run();

    expect(summary.spikes).toHaveLength(0);
    expect(summary.rejections['below-mention-floor']).toBe(1);
  });

  it('dry run computes baselines but records nothing', async () => {
    await seedTicker({ ticker: 'NVDA', perHour: 2, surge: 40 });

    const summary = await detectSpikes(
      { pool: pool!, logger: silentLogger },
      { windowStart: WINDOW_START, dryRun: true },
    );

    expect(summary.spikes).toHaveLength(1);
    expect(summary.recorded).toBe(0);
    expect(await recentSpikes(pool!)).toHaveLength(0);
    expect(summary.baselinesWritten).toBe(1);
  });

  it('handles an empty database', async () => {
    const summary = await run();
    expect(summary).toMatchObject({ tickersConsidered: 0, baselinesWritten: 0, recorded: 0 });
  });

  it('scores several tickers independently in one pass', async () => {
    await seedTicker({ ticker: 'NVDA', perHour: 2, surge: 40 });
    await seedTicker({ ticker: 'AAPL', perHour: 5, surge: 5 });
    await seedTicker({ ticker: 'AMD', perHour: 1, surge: 30 });

    const summary = await run();

    expect(summary.tickersConsidered).toBe(3);
    expect(summary.spikes.map((s) => s.tickerOrTopic).sort()).toEqual(['AMD', 'NVDA']);
  });
});

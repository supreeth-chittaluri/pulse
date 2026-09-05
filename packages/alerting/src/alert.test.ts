import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { countAlertsToday, createPool, recentAlerts, type Logger, type Pool } from '@pulse/core';
import { runMigrations } from '../../../db/migrate.ts';
import { sendPendingAlerts, formatAlert, DEFAULT_ALERT_CONFIG } from './alert.ts';
import { NotifierError, maskNumber, type Notifier } from './notifier.ts';

/**
 * Real Postgres, fake notifier.
 *
 * The database half must be real -- the idempotency guarantee is a unique
 * constraint, and mocking it away would leave the thing that stops duplicate
 * texts untested. The notifier half must be fake, because a suite that can send
 * a real SMS will eventually send a hundred and bill for all of them.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
try {
  process.loadEnvFile(resolve(repoRoot, '.env'));
} catch {
  /* docker-compose defaults below */
}

const baseUrl = process.env.DATABASE_URL ?? 'postgres://pulse:pulse@localhost:5433/pulse';
const TEST_DATABASE = 'pulse_alerts_test';

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
  console.warn(`\n  SKIPPING alert tests -- Postgres unreachable: ${skipReason}\n`);
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

const TO = '+15551234821';

function fakeNotifier(
  behaviour: (to: string, body: string, call: number) => void = () => {},
): Notifier & { sent: Array<{ to: string; body: string }> } {
  const sent: Array<{ to: string; body: string }> = [];
  return {
    channel: 'sms',
    from: '+15559999999',
    sent,
    async send(to, body) {
      behaviour(to, body, sent.length + 1);
      sent.push({ to, body });
      return { providerMessageId: `SM${sent.length}` };
    },
  };
}

/**
 * Distinct window per seeded spike: spikes are unique on
 * (ticker_or_topic, window_start), so reusing one would silently collide.
 */
let windowCounter = 0;
function nextWindow(): Date {
  windowCounter += 1;
  return new Date(Date.UTC(2026, 8, 1) + windowCounter * 3_600_000);
}

/** Seeds a spike, optionally watchlisted, and returns its id. */
async function seedSpike(options: {
  ticker: string;
  kind?: 'volume' | 'volume+sentiment';
  watched?: boolean;
  detectedAt?: Date;
  lastAlertedAt?: Date | null;
  windowStart?: Date;
  sentiment?: number | null;
}): Promise<number> {
  const {
    ticker,
    kind = 'volume+sentiment',
    watched = true,
    detectedAt = new Date(),
    lastAlertedAt = null,
    windowStart = nextWindow(),
    sentiment = -0.7,
  } = options;

  if (watched) {
    await pool!.query(
      `insert into watchlist (ticker_or_topic, alert_threshold, last_alerted_at)
       values ($1, 3.0, $2)
       on conflict (ticker_or_topic) do update set last_alerted_at = excluded.last_alerted_at`,
      [ticker, lastAlertedAt],
    );
  }

  const { rows } = await pool!.query<{ id: string }>(
    `insert into spikes
       (ticker_or_topic, detected_at, window_start, window_end, mention_count,
        volume_z, sentiment_z, current_sentiment, baseline_avg_volume, kind)
     values ($1, $2, $3::timestamptz, $3::timestamptz + interval '1 hour',
             42, 5.2, $4, $5, 2.4, $6)
     returning id`,
    [ticker, detectedAt, windowStart, sentiment === null ? null : -4.1, sentiment, kind],
  );
  return Number(rows[0]!.id);
}

function deps(notifier: Notifier) {
  return { pool: pool!, notifier, logger: silentLogger, to: TO };
}

describe('maskNumber', () => {
  it('keeps only the country prefix and last four digits', () => {
    expect(maskNumber('+15551234821')).toBe('+1******4821');
    expect(maskNumber('15551234821')).toBe('1******4821');
  });

  it('reveals nothing for a short string', () => {
    expect(maskNumber('12345')).toBe('*****');
  });
});

describe('formatAlert', () => {
  const spike = {
    spikeId: 1,
    tickerOrTopic: 'NVDA',
    detectedAt: new Date(),
    mentionCount: 42,
    volumeZ: 5.23,
    sentimentZ: -4.1,
    currentSentiment: -0.72,
    baselineAvgVolume: 2.4,
    kind: 'volume+sentiment' as const,
    alertThreshold: 3,
    lastAlertedAt: null,
  };

  it('names the ticker, the direction, and the numbers behind the call', () => {
    const body = formatAlert(spike);
    expect(body).toContain('NVDA');
    expect(body).toContain('bearish');
    expect(body).toContain('42 mentions');
    expect(body).toContain('2.4/hr');
    expect(body).toContain('-0.72');
  });

  // Twilio bills per 160-character segment, so a chatty template silently
  // multiplies the cost of every alert.
  it('fits in one SMS segment', () => {
    expect(formatAlert(spike).length).toBeLessThanOrEqual(160);
    const longest = formatAlert({
      ...spike,
      tickerOrTopic: 'GOOGL',
      mentionCount: 999999,
      volumeZ: 999.99,
      baselineAvgVolume: 99999.9,
      currentSentiment: -0.99,
    });
    expect(longest.length).toBeLessThanOrEqual(160);
  });

  it('omits direction when sentiment is unknown', () => {
    const body = formatAlert({ ...spike, currentSentiment: null, kind: 'volume' });
    expect(body).not.toContain('bearish');
    expect(body).toContain('NVDA');
  });
});

describe.skipIf(skipReason !== null)('sendPendingAlerts', () => {
  beforeEach(async () => {
    await pool!.query('truncate alerts, spikes, watchlist restart identity cascade');
  });

  it('sends one SMS for a watched volume+sentiment spike', async () => {
    await seedSpike({ ticker: 'NVDA' });
    const notifier = fakeNotifier();

    const summary = await sendPendingAlerts(deps(notifier));

    expect(summary.sent).toBe(1);
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]!.to).toBe(TO);
    expect(notifier.sent[0]!.body).toContain('NVDA');
  });

  // The watchlist is the opt-in. A spike on a ticker nobody asked about is
  // recorded but must never buzz a phone.
  it('ignores spikes on tickers that are not watchlisted', async () => {
    await seedSpike({ ticker: 'AMD', watched: false });
    const notifier = fakeNotifier();

    const summary = await sendPendingAlerts(deps(notifier));

    expect(summary.considered).toBe(0);
    expect(notifier.sent).toHaveLength(0);
  });

  it('ignores volume-only spikes by default', async () => {
    await seedSpike({ ticker: 'NVDA', kind: 'volume' });
    const notifier = fakeNotifier();

    const summary = await sendPendingAlerts(deps(notifier));

    // A volume surge with flat sentiment is usually a scheduled news cycle;
    // alerting on those is how an alert channel gets muted.
    expect(summary.skipped['wrong-kind']).toBe(1);
    expect(notifier.sent).toHaveLength(0);
  });

  it('sends volume-only spikes when configured to', async () => {
    await seedSpike({ ticker: 'NVDA', kind: 'volume' });
    const notifier = fakeNotifier();

    const summary = await sendPendingAlerts(deps(notifier), {
      ...DEFAULT_ALERT_CONFIG,
      kind: 'any',
    });

    expect(summary.sent).toBe(1);
  });

  // The single most important property: a restart must not re-text you.
  it('never sends twice for the same spike', async () => {
    await seedSpike({ ticker: 'NVDA' });
    const notifier = fakeNotifier();

    await sendPendingAlerts(deps(notifier));
    const second = await sendPendingAlerts(deps(notifier));

    expect(notifier.sent).toHaveLength(1);
    expect(second.considered).toBe(0);
    expect(await countAlertsToday(pool!)).toBe(1);
  });

  it('honours the per-ticker cooldown', async () => {
    await seedSpike({
      ticker: 'NVDA',
      lastAlertedAt: new Date(Date.now() - 60 * 60 * 1000), // 1h ago, cooldown is 6h
    });
    const notifier = fakeNotifier();

    const summary = await sendPendingAlerts(deps(notifier));

    expect(summary.skipped.cooldown).toBe(1);
    expect(notifier.sent).toHaveLength(0);
  });

  it('sends again once the cooldown has expired', async () => {
    await seedSpike({ ticker: 'NVDA', lastAlertedAt: new Date(Date.now() - 24 * 3_600_000) });
    const notifier = fakeNotifier();

    expect((await sendPendingAlerts(deps(notifier))).sent).toBe(1);
  });

  // Two spikes on one ticker in a single run must not both fire; the database
  // cooldown has not been written yet when the second is considered.
  it('applies the cooldown within a single run', async () => {
    await seedSpike({ ticker: 'NVDA', windowStart: new Date(Date.now() - 7_200_000) });
    await seedSpike({ ticker: 'NVDA', windowStart: new Date(Date.now() - 3_600_000) });
    const notifier = fakeNotifier();

    const summary = await sendPendingAlerts(deps(notifier));

    expect(summary.sent).toBe(1);
    expect(summary.skipped.cooldown).toBe(1);
  });

  it('ignores a stale spike so a backlog cannot flood you on startup', async () => {
    await seedSpike({ ticker: 'NVDA', detectedAt: new Date(Date.now() - 48 * 3_600_000) });
    const notifier = fakeNotifier();

    const summary = await sendPendingAlerts(deps(notifier));

    expect(summary.skipped['too-old']).toBe(1);
    expect(notifier.sent).toHaveLength(0);
  });

  // The last brake. Even if every other filter is wrong, spend is capped.
  it('refuses to exceed the daily budget', async () => {
    for (const ticker of ['NVDA', 'TSLA', 'AMD']) {
      await seedSpike({ ticker });
    }
    const notifier = fakeNotifier();

    const summary = await sendPendingAlerts(deps(notifier), {
      ...DEFAULT_ALERT_CONFIG,
      dailyBudget: 2,
    });

    expect(summary.sent).toBe(2);
    expect(summary.skipped.budget).toBe(1);
    expect(notifier.sent).toHaveLength(2);
  });

  it('counts alerts already sent today against the budget', async () => {
    await seedSpike({ ticker: 'NVDA' });
    await sendPendingAlerts(deps(fakeNotifier()));

    await seedSpike({ ticker: 'TSLA' });
    const notifier = fakeNotifier();
    const summary = await sendPendingAlerts(deps(notifier), {
      ...DEFAULT_ALERT_CONFIG,
      dailyBudget: 1,
    });

    expect(summary.skipped.budget).toBe(1);
    expect(notifier.sent).toHaveLength(0);
  });

  it('stores the destination masked, never in clear', async () => {
    await seedSpike({ ticker: 'NVDA' });
    await sendPendingAlerts(deps(fakeNotifier()));

    const { rows } = await pool!.query<{ destination_masked: string }>(
      'select destination_masked from alerts',
    );
    expect(rows[0]!.destination_masked).toBe('+1******4821');
    expect(rows[0]!.destination_masked).not.toContain('5551234');
  });

  it('stamps the watchlist cooldown on a successful send', async () => {
    await seedSpike({ ticker: 'NVDA' });
    await sendPendingAlerts(deps(fakeNotifier()));

    const { rows } = await pool!.query<{ last_alerted_at: Date | null }>(
      'select last_alerted_at from watchlist',
    );
    expect(rows[0]!.last_alerted_at).toBeInstanceOf(Date);
  });

  describe('failures', () => {
    it('records a non-retryable failure so it is not attempted again', async () => {
      await seedSpike({ ticker: 'NVDA' });
      const notifier = fakeNotifier(() => {
        // A bad number or bad credentials: retrying spends money to fail again.
        throw new NotifierError('Twilio 400: unverified number', 400, false);
      });

      const summary = await sendPendingAlerts(deps(notifier));
      expect(summary.failed).toBe(1);

      const [stored] = await recentAlerts(pool!);
      expect(stored?.error).toContain('unverified');

      // Second run must not retry it.
      const retry = await sendPendingAlerts(deps(fakeNotifier()));
      expect(retry.considered).toBe(0);
    });

    it('leaves a retryable failure to be picked up next run', async () => {
      await seedSpike({ ticker: 'NVDA' });
      const failing = fakeNotifier(() => {
        throw new NotifierError('Twilio 503: service unavailable', 503, true);
      });

      expect((await sendPendingAlerts(deps(failing))).failed).toBe(1);
      expect(await recentAlerts(pool!)).toHaveLength(0);

      const recovered = fakeNotifier();
      expect((await sendPendingAlerts(deps(recovered))).sent).toBe(1);
    });

    it('does not let one failure stop the rest of the batch', async () => {
      await seedSpike({ ticker: 'NVDA' });
      await seedSpike({ ticker: 'TSLA' });
      const notifier = fakeNotifier((_to, body) => {
        if (body.includes('NVDA')) throw new NotifierError('boom', 400, false);
      });

      const summary = await sendPendingAlerts(deps(notifier), {
        ...DEFAULT_ALERT_CONFIG,
        cooldownHours: 0,
      });

      expect(summary.failed).toBe(1);
      expect(summary.sent).toBe(1);
    });
  });

  describe('dry run', () => {
    it('renders every message and sends none', async () => {
      await seedSpike({ ticker: 'NVDA' });
      const notifier = fakeNotifier(() => {
        throw new Error('dry run must not send');
      });

      const summary = await sendPendingAlerts(deps(notifier), DEFAULT_ALERT_CONFIG, {
        dryRun: true,
      });

      expect(summary.bodies).toHaveLength(1);
      expect(summary.bodies[0]).toContain('NVDA');
      expect(summary.sent).toBe(0);
      expect(notifier.sent).toHaveLength(0);
      expect(await recentAlerts(pool!)).toHaveLength(0);
    });
  });
});

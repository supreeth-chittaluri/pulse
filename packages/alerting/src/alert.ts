import {
  countAlertsToday,
  recordAlert,
  selectAlertableSpikes,
  type Logger,
  type PendingSpike,
  type Pool,
} from '@pulse/core';
import { NotifierError, maskNumber, type Notifier } from './notifier.ts';

export type AlertKind = 'volume+sentiment' | 'any';

export type AlertConfig = {
  /**
   * Which spikes are worth a phone buzzing.
   *
   * Default is volume+sentiment only: a volume surge with flat sentiment is
   * usually a scheduled news cycle, and an alert channel that fires on those
   * gets muted within a week, which makes it worse than no alerts at all.
   */
  kind: AlertKind;
  /** Hours to wait before alerting on the same ticker again. */
  cooldownHours: number;
  /** Hard ceiling on SMS per rolling 24h. This is the spend guard. */
  dailyBudget: number;
  /** Ignore spikes older than this on startup, so a backlog cannot flood you. */
  maxSpikeAgeHours: number;
};

export const DEFAULT_ALERT_CONFIG: AlertConfig = {
  kind: 'volume+sentiment',
  cooldownHours: 6,
  dailyBudget: 10,
  maxSpikeAgeHours: 6,
};

export type AlertDeps = {
  pool: Pool;
  notifier: Notifier;
  logger: Logger;
  /** Destination number. Masked before it reaches the database or the logs. */
  to: string;
};

export type SkipReason = 'wrong-kind' | 'cooldown' | 'too-old' | 'budget';

export type AlertSummary = {
  considered: number;
  sent: number;
  failed: number;
  skipped: Record<SkipReason, number>;
  bodies: string[];
};

/**
 * Renders the SMS.
 *
 * Kept under 160 characters so it stays one segment: Twilio bills per segment,
 * and a chatty template silently triples the cost of every alert.
 */
export function formatAlert(spike: PendingSpike): string {
  const direction =
    spike.currentSentiment === null
      ? ''
      : spike.currentSentiment > 0
        ? ' bullish'
        : spike.currentSentiment < 0
          ? ' bearish'
          : ' neutral';

  const sentiment =
    spike.currentSentiment === null
      ? ''
      : ` ${spike.currentSentiment > 0 ? '+' : ''}${spike.currentSentiment.toFixed(2)}`;

  const body =
    `pulse: ${spike.tickerOrTopic}${direction} spike. ` +
    `${spike.mentionCount} mentions vs ${spike.baselineAvgVolume.toFixed(1)}/hr ` +
    `(z ${spike.volumeZ.toFixed(1)})${sentiment}`;

  return body.length > 160 ? `${body.slice(0, 157)}...` : body;
}

function shouldSend(
  spike: PendingSpike,
  config: AlertConfig,
  now: number,
): { ok: true } | { ok: false; reason: SkipReason } {
  if (config.kind === 'volume+sentiment' && spike.kind !== 'volume+sentiment') {
    return { ok: false, reason: 'wrong-kind' };
  }
  if (now - spike.detectedAt.getTime() > config.maxSpikeAgeHours * 3_600_000) {
    return { ok: false, reason: 'too-old' };
  }
  if (
    spike.lastAlertedAt !== null &&
    now - spike.lastAlertedAt.getTime() < config.cooldownHours * 3_600_000
  ) {
    return { ok: false, reason: 'cooldown' };
  }
  return { ok: true };
}

/**
 * Sends SMS for spikes that deserve one.
 *
 * Four independent brakes, because this is the only code path in the project
 * that can spend money in a loop: the watchlist decides which tickers are in
 * scope at all, the kind filter decides which spikes matter, a per-ticker
 * cooldown stops one event texting repeatedly, and a rolling daily budget caps
 * total spend even if all three of those are somehow wrong.
 *
 * `dryRun` renders every message and sends none.
 */
export async function sendPendingAlerts(
  deps: AlertDeps,
  config: AlertConfig = DEFAULT_ALERT_CONFIG,
  options: { dryRun?: boolean; now?: () => number } = {},
): Promise<AlertSummary> {
  const { pool, notifier, logger, to } = deps;
  const now = options.now ?? Date.now;
  const dryRun = options.dryRun ?? false;

  const summary: AlertSummary = {
    considered: 0,
    sent: 0,
    failed: 0,
    skipped: { 'wrong-kind': 0, cooldown: 0, 'too-old': 0, budget: 0 },
    bodies: [],
  };

  const pending = await selectAlertableSpikes(pool);
  summary.considered = pending.length;
  if (pending.length === 0) return summary;

  let usedToday = await countAlertsToday(pool);
  const masked = maskNumber(to);

  // Cooldown is tracked in memory as well as in the database, so two spikes on
  // the same ticker inside one run cannot both fire.
  const alertedThisRun = new Map<string, number>();

  for (const spike of pending) {
    const lastAlertedAt = alertedThisRun.has(spike.tickerOrTopic)
      ? new Date(alertedThisRun.get(spike.tickerOrTopic)!)
      : spike.lastAlertedAt;

    const verdict = shouldSend({ ...spike, lastAlertedAt }, config, now());
    if (!verdict.ok) {
      summary.skipped[verdict.reason] += 1;
      continue;
    }

    if (usedToday + summary.sent >= config.dailyBudget) {
      summary.skipped.budget += 1;
      logger.warn('alert budget reached', { dailyBudget: config.dailyBudget, usedToday });
      continue;
    }

    const body = formatAlert(spike);
    summary.bodies.push(body);

    if (dryRun) continue;

    try {
      const result = await notifier.send(to, body);
      const stored = await recordAlert(pool, {
        spikeId: spike.spikeId,
        tickerOrTopic: spike.tickerOrTopic,
        destinationMasked: masked,
        body,
        providerMessageId: result.providerMessageId,
      });
      if (stored) {
        summary.sent += 1;
        alertedThisRun.set(spike.tickerOrTopic, now());
        logger.info('alert sent', {
          ticker: spike.tickerOrTopic,
          to: masked,
          messageId: result.providerMessageId,
        });
      }
    } catch (err) {
      summary.failed += 1;
      const error = err as NotifierError;
      logger.error('alert failed', {
        ticker: spike.tickerOrTopic,
        error: error.message,
        retryable: error.retryable ?? false,
      });

      // A non-retryable failure is recorded against the spike so it is not
      // attempted again on the next run -- otherwise a bad number would retry
      // forever. Retryable ones are left unrecorded so they come back.
      if (error instanceof NotifierError && !error.retryable) {
        await recordAlert(pool, {
          spikeId: spike.spikeId,
          tickerOrTopic: spike.tickerOrTopic,
          destinationMasked: masked,
          body,
          error: error.message,
        });
      }
    }
  }

  return summary;
}

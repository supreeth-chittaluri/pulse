import { createLogger, type Config, type Logger, type Pool } from '@pulse/core';
import { buildSources, MinIntervalGate, systemClock, type Source } from '@pulse/sources';
import { createTwilioNotifier, sendPendingAlerts } from '@pulse/alerting';
import { ingestSource } from './ingest.ts';
import { runScheduler } from './scheduler.ts';
import { detectSpikes } from './spikes.ts';
import { runAutomaticScoring } from './auto-score.ts';

/**
 * Reddit's .rss limiter is per client across ALL feeds, at roughly one request
 * per minute. Every Reddit adapter shares this bucket.
 */
export const REDDIT_MIN_INTERVAL_MS = 60_000;

const DETECTION_INTERVAL_MS = 5 * 60 * 1000;
const SCORING_CHECK_INTERVAL_MS = 60 * 1000;

async function sleepUntilNextCheck(signal: AbortSignal, intervalMs: number): Promise<void> {
  let remaining = intervalMs;
  while (remaining > 0 && !signal.aborted) {
    const chunk = Math.min(remaining, 500);
    await systemClock.sleep(chunk, signal);
    remaining -= chunk;
  }
}

/** Checks once a minute; the database grants only one run per 30-minute slot. */
async function scoringLoop(
  config: Config,
  pool: Pool,
  logger: Logger,
  signal: AbortSignal,
  intervalMs = SCORING_CHECK_INTERVAL_MS,
): Promise<void> {
  while (!signal.aborted) {
    try {
      await runAutomaticScoring(config, pool, logger);
    } catch (err) {
      logger.error('automatic scoring failed', { error: (err as Error).message });
    }
    await sleepUntilNextCheck(signal, intervalMs);
  }
}

/**
 * Spike detection, and alerting when it is switched on.
 *
 * Detection costs nothing, so it runs on a timer. Alerting spends money per
 * message, so it only runs when explicitly enabled -- and even then behind the
 * watchlist, kind filter, cooldown and daily budget in @pulse/alerting.
 */
async function detectionLoop(
  config: Config,
  pool: Pool,
  logger: Logger,
  signal: AbortSignal,
  intervalMs = DETECTION_INTERVAL_MS,
): Promise<void> {
  while (!signal.aborted) {
    try {
      const summary = await detectSpikes({ pool, logger });
      if (summary.recorded > 0) {
        logger.info('spikes recorded', {
          recorded: summary.recorded,
          tickers: summary.tickersConsidered,
        });

        if (config.alerts.enabled && config.alerts.configured) {
          const alerts = await sendPendingAlerts(
            {
              pool,
              notifier: createTwilioNotifier({
                accountSid: config.alerts.twilio.accountSid!,
                authToken: config.alerts.twilio.authToken!,
                from: config.alerts.twilio.from!,
              }),
              logger,
              to: config.alerts.twilio.to!,
            },
            {
              kind: config.alerts.kind,
              cooldownHours: config.alerts.cooldownHours,
              dailyBudget: config.alerts.dailyBudget,
              maxSpikeAgeHours: config.alerts.maxSpikeAgeHours,
            },
          );
          if (alerts.sent > 0) logger.info('alerts sent', { sent: alerts.sent });
        }
      }
    } catch (err) {
      // Detection failing must never take ingestion down with it.
      logger.error('spike detection failed', { error: (err as Error).message });
    }

    await sleepUntilNextCheck(signal, intervalMs);
  }
}

export type BackgroundOptions = {
  config: Config;
  pool: Pool;
  logger?: Logger;
  signal: AbortSignal;
  sources?: Source[];
};

/**
 * Ingestion, scoring and detection, running together until `signal` aborts.
 *
 * Shared by the standalone worker and by the API process. The API needs it
 * because free hosting tiers generally bill background workers but not web
 * services, so a $0 deployment has to run both in one process -- see docs/deployment.md.
 */
export async function runBackgroundLoops(options: BackgroundOptions): Promise<void> {
  const { config, pool, signal } = options;
  const logger = options.logger ?? createLogger('worker');
  const sources = options.sources ?? buildSources(config);
  const gate = new MinIntervalGate(REDDIT_MIN_INTERVAL_MS);

  await Promise.all([
    runScheduler({
      sources,
      logger,
      signal,
      runImmediately: true,
      run: (source, childSignal) => ingestSource({ pool, gate, logger }, source, childSignal),
    }),
    detectionLoop(config, pool, logger, signal),
    scoringLoop(config, pool, logger, signal),
  ]);
}

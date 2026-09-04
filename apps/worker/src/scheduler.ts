import type { Logger } from '@pulse/core';
import { systemClock, type Clock, type Source } from '@pulse/sources';

export type SchedulerOptions = {
  sources: Source[];
  /** What to do when a source comes due. Injected so tests need no network. */
  run: (source: Source) => Promise<unknown>;
  logger: Logger;
  clock?: Clock;
  /** Fetch everything once at startup instead of waiting out the first interval. */
  runImmediately?: boolean;
  /** Spread of the randomized offset applied to every interval. 0 disables it. */
  jitterPct?: number;
  /** Ceiling on failure backoff. */
  maxBackoffMs?: number;
  /** Injected for deterministic jitter in tests. */
  random?: () => number;
  signal?: AbortSignal;
};

export type SourceState = {
  source: Source;
  nextRunAt: number;
  consecutiveFailures: number;
};

const DEFAULT_JITTER_PCT = 0.1;
const DEFAULT_MAX_BACKOFF_MS = 60 * 60 * 1000;

/**
 * Longest single sleep. Bounding it keeps SIGTERM responsive: a worker waiting
 * out a 10-minute interval still shuts down within half a second.
 */
const MAX_SLEEP_CHUNK_MS = 500;

/**
 * Delay until a source should run again.
 *
 * On success that is its configured interval. On failure it is the interval
 * doubled per consecutive failure and capped, so a dead feed stops consuming
 * its share of the Reddit request budget instead of retrying on schedule.
 */
export function computeDelayMs(
  pollSeconds: number,
  consecutiveFailures: number,
  options: { jitterPct?: number; maxBackoffMs?: number; random?: () => number } = {},
): number {
  const jitterPct = options.jitterPct ?? DEFAULT_JITTER_PCT;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const random = options.random ?? Math.random;

  const baseMs = pollSeconds * 1000;
  const backoffMs =
    consecutiveFailures > 0
      ? Math.min(baseMs * 2 ** consecutiveFailures, maxBackoffMs)
      : baseMs;

  // Jitter keeps sources from converging into a thundering herd after a restart.
  const offset = jitterPct === 0 ? 0 : backoffMs * jitterPct * (random() * 2 - 1);
  return Math.max(0, Math.round(backoffMs + offset));
}

/**
 * Runs sources on their own schedules, one at a time.
 *
 * Serial by design: nine sources at about a second each is nothing, and it
 * removes any chance of two Reddit fetches overlapping. Cross-source pacing is
 * the gate's job (see MinIntervalGate); this only decides what runs when.
 *
 * Resolves when `signal` aborts.
 */
export async function runScheduler(options: SchedulerOptions): Promise<void> {
  const {
    sources,
    run,
    logger,
    clock = systemClock,
    runImmediately = true,
    jitterPct,
    maxBackoffMs,
    random,
    signal,
  } = options;

  if (sources.length === 0) {
    logger.warn('no enabled sources; scheduler has nothing to do');
    return;
  }

  const delayOptions = { jitterPct, maxBackoffMs, random };
  const now = clock.now();

  const states: SourceState[] = sources.map((source) => ({
    source,
    nextRunAt: runImmediately
      ? now
      : now + computeDelayMs(source.pollSeconds, 0, delayOptions),
    consecutiveFailures: 0,
  }));

  logger.info('scheduler started', {
    sources: states.length,
    runImmediately,
  });

  while (!signal?.aborted) {
    const next = states.reduce((earliest, state) =>
      state.nextRunAt < earliest.nextRunAt ? state : earliest,
    );

    let remaining = next.nextRunAt - clock.now();
    while (remaining > 0 && !signal?.aborted) {
      await clock.sleep(Math.min(remaining, MAX_SLEEP_CHUNK_MS));
      remaining = next.nextRunAt - clock.now();
    }
    if (signal?.aborted) break;

    let lastError: string | null = null;
    try {
      await run(next.source);
      next.consecutiveFailures = 0;
    } catch (err) {
      // Already logged in detail by the ingest step; one source failing must
      // never stop the loop.
      next.consecutiveFailures += 1;
      lastError = (err as Error).message;
    }

    // Computed once so the delay we log is the delay we actually apply.
    const delayMs = computeDelayMs(
      next.source.pollSeconds,
      next.consecutiveFailures,
      delayOptions,
    );
    if (lastError !== null) {
      logger.warn('source failed; backing off', {
        source: next.source.id,
        consecutiveFailures: next.consecutiveFailures,
        retryInMs: delayMs,
        error: lastError,
      });
    }

    next.nextRunAt = clock.now() + delayMs;
  }

  logger.info('scheduler stopped');
}

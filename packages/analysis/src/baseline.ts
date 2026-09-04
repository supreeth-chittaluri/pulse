import { countSpreadFloor, mean, stddev } from './statistics.ts';

export const HOUR_MS = 60 * 60 * 1000;

/** One scored mention, as the detector sees it. */
export type Observation = {
  /** Millisecond timestamp. Bucketed to the hour internally. */
  at: number;
  sentiment: number;
  /** Registry source id, e.g. "reddit:stocks". Used to exclude fixed-cadence feeds. */
  source: string;
};

export type BaselineConfig = {
  /** How much history the baseline spans. */
  windowHours: number;
  /** Minimum observations before a sentiment baseline is trustworthy. */
  minSamples: number;
  /** Minimum distinct hours with data, so one busy hour cannot form a baseline. */
  minBuckets: number;
  /** Lower bound on sentiment spread, guarding a ticker that never varies. */
  sentimentSpreadFloor: number;
};

export const DEFAULT_BASELINE_CONFIG: BaselineConfig = {
  windowHours: 168, // 7 days, matching baselines.window_hours
  minSamples: 20,
  minBuckets: 3,
  sentimentSpreadFloor: 0.1,
};

export type SentimentBaseline = {
  mean: number;
  /** Spread of INDIVIDUAL observations, before any standard-error correction. */
  stddev: number;
  sampleCount: number;
  bucketCount: number;
};

export type VolumeBaseline = {
  /** Mentions per hour, averaged over every hour in the window including empty ones. */
  mean: number;
  stddev: number;
  /** Spread with the Poisson floor applied; this is what the z-score divides by. */
  spread: number;
  bucketCount: number;
  totalMentions: number;
};

export function bucketOf(at: number): number {
  return Math.floor(at / HOUR_MS) * HOUR_MS;
}

/**
 * Observations strictly BEFORE `windowStart` and within the configured window.
 *
 * The exclusion is the point. If the window being tested also feeds the
 * baseline, a large spike drags the mean up and inflates the standard
 * deviation, suppressing its own z-score -- the bigger the event, the less it
 * fires. The baseline must never see the data it is judging.
 */
export function selectBaselineWindow(
  observations: Observation[],
  windowStart: number,
  config: BaselineConfig = DEFAULT_BASELINE_CONFIG,
): Observation[] {
  const earliest = windowStart - config.windowHours * HOUR_MS;
  return observations.filter((o) => o.at >= earliest && o.at < windowStart);
}

export function computeSentimentBaseline(
  observations: Observation[],
  config: BaselineConfig = DEFAULT_BASELINE_CONFIG,
): SentimentBaseline | null {
  if (observations.length < config.minSamples) return null;

  const buckets = new Set(observations.map((o) => bucketOf(o.at)));
  if (buckets.size < config.minBuckets) return null;

  const scores = observations.map((o) => o.sentiment);
  const mu = mean(scores);
  return {
    mean: mu,
    stddev: Math.max(stddev(scores, mu), config.sentimentSpreadFloor),
    sampleCount: scores.length,
    bucketCount: buckets.size,
  };
}

/**
 * Hourly mention-rate baseline.
 *
 * Hours with no mentions are counted as zeros. Averaging only the hours that
 * happen to contain data would answer "how many mentions does this ticker get
 * in an hour where it is mentioned at all", which is close to 1 for every
 * ticker and useless as a baseline.
 */
export function computeVolumeBaseline(
  observations: Observation[],
  windowStart: number,
  config: BaselineConfig = DEFAULT_BASELINE_CONFIG,
): VolumeBaseline | null {
  const earliest = bucketOf(windowStart - config.windowHours * HOUR_MS);
  const lastBucket = bucketOf(windowStart) - HOUR_MS;
  if (lastBucket < earliest) return null;

  const counts = new Map<number, number>();
  for (let bucket = earliest; bucket <= lastBucket; bucket += HOUR_MS) counts.set(bucket, 0);

  let observed = 0;
  for (const observation of observations) {
    const bucket = bucketOf(observation.at);
    if (!counts.has(bucket)) continue;
    counts.set(bucket, counts.get(bucket)! + 1);
    observed += 1;
  }

  const nonEmpty = [...counts.values()].filter((c) => c > 0).length;
  if (nonEmpty < config.minBuckets || observed < config.minSamples) return null;

  const series = [...counts.values()];
  const mu = mean(series);
  const sigma = stddev(series, mu);

  return {
    mean: mu,
    stddev: sigma,
    spread: Math.max(sigma, countSpreadFloor(mu)),
    bucketCount: series.length,
    totalMentions: observed,
  };
}

/**
 * Google News polls on a fixed schedule, so those feeds contribute an almost
 * constant number of mentions per hour for their configured tickers. Leaving
 * them in the volume baseline shrinks its variance and makes ordinary
 * fluctuation look statistically significant. They still count toward the
 * sentiment baseline, where cadence does not distort anything.
 */
export function isFixedCadenceSource(source: string): boolean {
  return source.startsWith('news:');
}

export function excludeFixedCadence(observations: Observation[]): Observation[] {
  return observations.filter((o) => !isFixedCadenceSource(o.source));
}

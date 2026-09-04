import {
  bucketOf,
  computeSentimentBaseline,
  computeVolumeBaseline,
  excludeFixedCadence,
  selectBaselineWindow,
  DEFAULT_BASELINE_CONFIG,
  HOUR_MS,
  type BaselineConfig,
  type Observation,
  type SentimentBaseline,
  type VolumeBaseline,
} from './baseline.ts';
import { mean, standardError, zScore } from './statistics.ts';

export type DetectionConfig = BaselineConfig & {
  /** z at or above which a volume surge counts as a spike. */
  threshold: number;
  /**
   * Absolute mentions required in the tested window, regardless of z.
   * Without it a ticker going from 0.05 mentions/hour to 1 scores z=4 and
   * alerts on a single post.
   */
  minMentions: number;
  /** Suppress repeats for this many hours after a detection. */
  cooldownHours: number;
};

export const DEFAULT_DETECTION_CONFIG: DetectionConfig = {
  ...DEFAULT_BASELINE_CONFIG,
  // 3.0 rather than the schema's 2.5 default: at 2.5 and ~90 tickers checked
  // hourly, normally-distributed noise alone produces roughly one false alert
  // an hour, which would make M7's SMS worthless. watchlist.alert_threshold
  // still overrides this per ticker.
  threshold: 3.0,
  minMentions: 5,
  cooldownHours: 6,
};

export type SpikeKind = 'volume' | 'volume+sentiment';

export type Spike = {
  tickerOrTopic: string;
  windowStart: number;
  windowEnd: number;
  mentionCount: number;
  volumeZ: number;
  sentimentZ: number | null;
  currentSentiment: number | null;
  baselineAvgVolume: number;
  baselineAvgSentiment: number | null;
  kind: SpikeKind;
};

export type DetectionInput = {
  tickerOrTopic: string;
  /** Every observation for this ticker, baseline history and current window alike. */
  observations: Observation[];
  /** Start of the window under test. Defaults to the most recent full hour. */
  windowStart: number;
  /** When this ticker last produced a spike, for cooldown. */
  lastDetectedAt?: number | null;
  /** Per-ticker override from the watchlist. */
  threshold?: number;
};

export type Rejection =
  | 'cooldown'
  | 'below-mention-floor'
  | 'no-volume-baseline'
  | 'below-threshold';

export type DetectionResult =
  | { spike: Spike; rejected: null }
  | { spike: null; rejected: Rejection };

/**
 * Decides whether one ticker spiked in one window.
 *
 * Volume is the gate: a sentiment swing measured over two mentions is noise, so
 * nothing fires without a real surge in how much the ticker is being discussed.
 * Sentiment then classifies the result -- a surge with a matching sentiment
 * shift is the case worth waking someone up for, and is the only kind M7 will
 * text about.
 */
export function detectSpike(
  input: DetectionInput,
  config: DetectionConfig = DEFAULT_DETECTION_CONFIG,
): DetectionResult {
  const { tickerOrTopic, observations, windowStart } = input;
  const windowEnd = windowStart + HOUR_MS;
  const threshold = input.threshold ?? config.threshold;

  if (
    input.lastDetectedAt != null &&
    windowStart - input.lastDetectedAt < config.cooldownHours * HOUR_MS
  ) {
    return { spike: null, rejected: 'cooldown' };
  }

  const current = observations.filter((o) => o.at >= windowStart && o.at < windowEnd);
  const currentVolume = excludeFixedCadence(current);
  if (currentVolume.length < config.minMentions) {
    return { spike: null, rejected: 'below-mention-floor' };
  }

  const history = selectBaselineWindow(observations, windowStart, config);

  // Fixed-cadence news feeds are excluded from BOTH sides of the volume
  // comparison, or the baseline and the observation would not be like for like.
  const volumeBaseline: VolumeBaseline | null = computeVolumeBaseline(
    excludeFixedCadence(history),
    windowStart,
    config,
  );
  if (!volumeBaseline) return { spike: null, rejected: 'no-volume-baseline' };

  const volumeZ = zScore(currentVolume.length, volumeBaseline.mean, volumeBaseline.spread);
  if (volumeZ < threshold) return { spike: null, rejected: 'below-threshold' };

  // Sentiment uses every source: a news feed's cadence is artificial, but what
  // it says is not.
  const sentimentBaseline: SentimentBaseline | null = computeSentimentBaseline(history, config);
  const currentSentiment = current.length > 0 ? mean(current.map((o) => o.sentiment)) : null;

  let sentimentZ: number | null = null;
  if (sentimentBaseline && currentSentiment !== null) {
    sentimentZ = zScore(
      currentSentiment,
      sentimentBaseline.mean,
      // Standard error, not raw stddev: we are testing a mean of `current.length`
      // observations, which is sqrt(n) times less noisy than a single one.
      standardError(sentimentBaseline.stddev, current.length),
    );
  }

  return {
    spike: {
      tickerOrTopic,
      windowStart,
      windowEnd,
      mentionCount: currentVolume.length,
      volumeZ,
      sentimentZ,
      currentSentiment,
      baselineAvgVolume: volumeBaseline.mean,
      baselineAvgSentiment: sentimentBaseline?.mean ?? null,
      kind:
        sentimentZ !== null && Math.abs(sentimentZ) >= threshold
          ? 'volume+sentiment'
          : 'volume',
    },
    rejected: null,
  };
}

/** The most recent fully-elapsed hour, which is the window normally tested. */
export function latestCompleteWindow(now: number = Date.now()): number {
  return bucketOf(now) - HOUR_MS;
}

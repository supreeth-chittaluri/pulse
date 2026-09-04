import {
  insertSpike,
  lastSpikePerTicker,
  selectObservationsSince,
  upsertBaseline,
  watchlistThresholds,
  type Logger,
  type Pool,
} from '@pulse/core';
import {
  computeSentimentBaseline,
  computeVolumeBaseline,
  detectSpike,
  excludeFixedCadence,
  latestCompleteWindow,
  selectBaselineWindow,
  DEFAULT_DETECTION_CONFIG,
  HOUR_MS,
  type DetectionConfig,
  type Observation,
  type Rejection,
  type Spike,
} from '@pulse/analysis';

export type DetectDeps = { pool: Pool; logger: Logger };

export type DetectOptions = {
  config?: DetectionConfig;
  /** Window to test. Defaults to the most recent fully-elapsed hour. */
  windowStart?: number;
  /** Compute and store baselines without recording any spike. */
  dryRun?: boolean;
};

export type DetectSummary = {
  windowStart: number;
  tickersConsidered: number;
  baselinesWritten: number;
  spikes: Spike[];
  recorded: number;
  rejections: Record<Rejection, number>;
};

/**
 * Runs one detection pass over every ticker.
 *
 * Free to run -- no model, no external API -- so unlike scoring this belongs on
 * the schedule rather than behind a manual command.
 */
export async function detectSpikes(
  deps: DetectDeps,
  options: DetectOptions = {},
): Promise<DetectSummary> {
  const { pool, logger } = deps;
  const config = options.config ?? DEFAULT_DETECTION_CONFIG;
  const windowStart = options.windowStart ?? latestCompleteWindow();

  const summary: DetectSummary = {
    windowStart,
    tickersConsidered: 0,
    baselinesWritten: 0,
    spikes: [],
    recorded: 0,
    rejections: {
      cooldown: 0,
      'below-mention-floor': 0,
      'no-volume-baseline': 0,
      'below-threshold': 0,
    },
  };

  const since = new Date(windowStart - config.windowHours * HOUR_MS);
  const rows = await selectObservationsSince(pool, since);

  const byTicker = new Map<string, Observation[]>();
  for (const row of rows) {
    const list = byTicker.get(row.tickerOrTopic) ?? [];
    list.push({ at: row.at.getTime(), sentiment: row.sentiment, source: row.source });
    byTicker.set(row.tickerOrTopic, list);
  }
  summary.tickersConsidered = byTicker.size;

  const [lastSpikes, thresholds] = await Promise.all([
    lastSpikePerTicker(pool),
    watchlistThresholds(pool),
  ]);

  for (const [tickerOrTopic, observations] of byTicker) {
    // Persist the baseline regardless of whether anything spiked: M6 charts it
    // and M9 measures against it, and it is the same computation either way.
    const history = selectBaselineWindow(observations, windowStart, config);
    const sentiment = computeSentimentBaseline(history, config);
    const volume = computeVolumeBaseline(excludeFixedCadence(history), windowStart, config);

    if (sentiment || volume) {
      await upsertBaseline(pool, {
        tickerOrTopic,
        rollingAvg: sentiment?.mean ?? null,
        rollingStddev: sentiment?.stddev ?? null,
        rollingAvgVolume: volume?.mean ?? null,
        rollingStddevVolume: volume?.stddev ?? null,
        sampleCount: sentiment?.sampleCount ?? 0,
        bucketCount: volume?.bucketCount ?? 0,
        windowHours: config.windowHours,
      });
      summary.baselinesWritten += 1;
    }

    const result = detectSpike(
      {
        tickerOrTopic,
        observations,
        windowStart,
        lastDetectedAt: lastSpikes.get(tickerOrTopic)?.getTime() ?? null,
        threshold: thresholds.get(tickerOrTopic),
      },
      config,
    );

    if (result.spike === null) {
      summary.rejections[result.rejected] += 1;
      continue;
    }

    summary.spikes.push(result.spike);
    if (options.dryRun) continue;

    const stored = await insertSpike(pool, {
      tickerOrTopic: result.spike.tickerOrTopic,
      windowStart: new Date(result.spike.windowStart),
      windowEnd: new Date(result.spike.windowEnd),
      mentionCount: result.spike.mentionCount,
      volumeZ: result.spike.volumeZ,
      sentimentZ: result.spike.sentimentZ,
      currentSentiment: result.spike.currentSentiment,
      baselineAvgVolume: result.spike.baselineAvgVolume,
      baselineAvgSentiment: result.spike.baselineAvgSentiment,
      kind: result.spike.kind,
    });
    if (stored) summary.recorded += 1;

    logger.info('spike detected', {
      ticker: result.spike.tickerOrTopic,
      kind: result.spike.kind,
      mentions: result.spike.mentionCount,
      volumeZ: Number(result.spike.volumeZ.toFixed(2)),
      sentimentZ:
        result.spike.sentimentZ === null ? null : Number(result.spike.sentimentZ.toFixed(2)),
      alreadyRecorded: !stored,
    });
  }

  return summary;
}

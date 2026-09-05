import type { Pool } from 'pg';

export type SignalObservation = {
  tickerOrTopic: string;
  at: Date;
  sentiment: number;
  source: string;
};

/**
 * Every signal inside the baseline window plus the window under test, for every
 * ticker at once.
 *
 * One query rather than one per ticker: at 91 tickers and a 7-day window this
 * is a few thousand rows, and the alternative is 91 round trips per detection
 * run for no benefit.
 */
export async function selectObservationsSince(
  pool: Pool,
  since: Date,
): Promise<SignalObservation[]> {
  const { rows } = await pool.query<{
    ticker_or_topic: string;
    scraped_at: Date;
    sentiment_score: number;
    source: string;
  }>(
    `select ticker_or_topic, scraped_at, sentiment_score, source
       from signals
      where scraped_at >= $1
      order by scraped_at asc`,
    [since],
  );
  return rows.map((row) => ({
    tickerOrTopic: row.ticker_or_topic,
    at: row.scraped_at,
    sentiment: row.sentiment_score,
    source: row.source,
  }));
}

export type BaselineRow = {
  tickerOrTopic: string;
  rollingAvg: number | null;
  rollingStddev: number | null;
  rollingAvgVolume: number | null;
  rollingStddevVolume: number | null;
  sampleCount: number;
  bucketCount: number;
  windowHours: number;
};

export async function upsertBaseline(pool: Pool, row: BaselineRow): Promise<void> {
  await pool.query(
    `insert into baselines
       (ticker_or_topic, rolling_avg, rolling_stddev, rolling_avg_volume,
        rolling_stddev_volume, sample_count, bucket_count, window_hours, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, now())
     on conflict (ticker_or_topic) do update set
       rolling_avg           = excluded.rolling_avg,
       rolling_stddev        = excluded.rolling_stddev,
       rolling_avg_volume    = excluded.rolling_avg_volume,
       rolling_stddev_volume = excluded.rolling_stddev_volume,
       sample_count          = excluded.sample_count,
       bucket_count          = excluded.bucket_count,
       window_hours          = excluded.window_hours,
       updated_at            = now()`,
    [
      row.tickerOrTopic,
      row.rollingAvg,
      row.rollingStddev,
      row.rollingAvgVolume,
      row.rollingStddevVolume,
      row.sampleCount,
      row.bucketCount,
      row.windowHours,
    ],
  );
}

export type SpikeRow = {
  tickerOrTopic: string;
  windowStart: Date;
  windowEnd: Date;
  mentionCount: number;
  volumeZ: number;
  sentimentZ: number | null;
  currentSentiment: number | null;
  baselineAvgVolume: number;
  baselineAvgSentiment: number | null;
  kind: 'volume' | 'volume+sentiment';
};

/**
 * Records a spike. Returns false when this ticker/window was already recorded,
 * so re-running detection over the same hour is a no-op rather than a duplicate.
 */
export async function insertSpike(pool: Pool, row: SpikeRow): Promise<boolean> {
  const { rowCount } = await pool.query(
    `insert into spikes
       (ticker_or_topic, window_start, window_end, mention_count, volume_z,
        sentiment_z, current_sentiment, baseline_avg_volume, baseline_avg_sentiment, kind)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     on conflict (ticker_or_topic, window_start) do nothing`,
    [
      row.tickerOrTopic,
      row.windowStart,
      row.windowEnd,
      row.mentionCount,
      row.volumeZ,
      row.sentimentZ,
      row.currentSentiment,
      row.baselineAvgVolume,
      row.baselineAvgSentiment,
      row.kind,
    ],
  );
  return (rowCount ?? 0) > 0;
}

/** Most recent detection per ticker, for the cooldown check. */
export async function lastSpikePerTicker(pool: Pool): Promise<Map<string, Date>> {
  const { rows } = await pool.query<{ ticker_or_topic: string; window_start: Date }>(
    `select distinct on (ticker_or_topic) ticker_or_topic, window_start
       from spikes
      order by ticker_or_topic, window_start desc`,
  );
  return new Map(rows.map((row) => [row.ticker_or_topic, row.window_start]));
}

/** Per-ticker threshold overrides from the watchlist. */
export async function watchlistThresholds(pool: Pool): Promise<Map<string, number>> {
  const { rows } = await pool.query<{ ticker_or_topic: string; alert_threshold: number }>(
    'select ticker_or_topic, alert_threshold from watchlist',
  );
  return new Map(rows.map((row) => [row.ticker_or_topic, row.alert_threshold]));
}

export type RecentSpike = SpikeRow & { detectedAt: Date };

export async function recentSpikes(pool: Pool, limit = 20): Promise<RecentSpike[]> {
  const { rows } = await pool.query<{
    ticker_or_topic: string;
    detected_at: Date;
    window_start: Date;
    window_end: Date;
    mention_count: number;
    volume_z: number;
    sentiment_z: number | null;
    current_sentiment: number | null;
    baseline_avg_volume: number;
    baseline_avg_sentiment: number | null;
    kind: 'volume' | 'volume+sentiment';
  }>('select * from spikes order by detected_at desc limit $1', [limit]);

  return rows.map((row) => ({
    tickerOrTopic: row.ticker_or_topic,
    detectedAt: row.detected_at,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    mentionCount: row.mention_count,
    volumeZ: row.volume_z,
    sentimentZ: row.sentiment_z,
    currentSentiment: row.current_sentiment,
    baselineAvgVolume: row.baseline_avg_volume,
    baselineAvgSentiment: row.baseline_avg_sentiment,
    kind: row.kind,
  }));
}

/** Spikes newer than a cursor, oldest first. Drives the live stream. */
export async function selectSpikesAfterId(
  pool: Pool,
  afterId: number,
  limit: number,
): Promise<Array<RecentSpike & { id: number }>> {
  const { rows } = await pool.query<{
    id: string;
    ticker_or_topic: string;
    detected_at: Date;
    window_start: Date;
    window_end: Date;
    mention_count: number;
    volume_z: number;
    sentiment_z: number | null;
    current_sentiment: number | null;
    baseline_avg_volume: number;
    baseline_avg_sentiment: number | null;
    kind: 'volume' | 'volume+sentiment';
  }>('select * from spikes where id > $1 order by id asc limit $2', [afterId, limit]);

  return rows.map((row) => ({
    id: Number(row.id),
    tickerOrTopic: row.ticker_or_topic,
    detectedAt: row.detected_at,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    mentionCount: row.mention_count,
    volumeZ: row.volume_z,
    sentimentZ: row.sentiment_z,
    currentSentiment: row.current_sentiment,
    baselineAvgVolume: row.baseline_avg_volume,
    baselineAvgSentiment: row.baseline_avg_sentiment,
    kind: row.kind,
  }));
}

import type { Pool } from 'pg';

export type PendingSpike = {
  spikeId: number;
  tickerOrTopic: string;
  detectedAt: Date;
  mentionCount: number;
  volumeZ: number;
  sentimentZ: number | null;
  currentSentiment: number | null;
  baselineAvgVolume: number;
  kind: 'volume' | 'volume+sentiment';
  alertThreshold: number;
  lastAlertedAt: Date | null;
};

/**
 * Spikes on watchlisted tickers that have not produced an SMS yet.
 *
 * The watchlist is the opt-in: a spike on a ticker nobody asked about is
 * recorded but never texted. The left join against alerts is what makes a
 * re-run cheap -- already-alerted spikes never come back.
 */
export async function selectAlertableSpikes(pool: Pool, limit = 20): Promise<PendingSpike[]> {
  const { rows } = await pool.query<{
    id: string;
    ticker_or_topic: string;
    detected_at: Date;
    mention_count: number;
    volume_z: number;
    sentiment_z: number | null;
    current_sentiment: number | null;
    baseline_avg_volume: number;
    kind: 'volume' | 'volume+sentiment';
    alert_threshold: number;
    last_alerted_at: Date | null;
  }>(
    `select s.id, s.ticker_or_topic, s.detected_at, s.mention_count, s.volume_z,
            s.sentiment_z, s.current_sentiment, s.baseline_avg_volume, s.kind,
            w.alert_threshold, w.last_alerted_at
       from spikes s
       join watchlist w on w.ticker_or_topic = s.ticker_or_topic
       left join alerts a on a.spike_id = s.id and a.channel = 'sms'
      where a.id is null
      order by s.detected_at asc
      limit $1`,
    [limit],
  );

  return rows.map((row) => ({
    spikeId: Number(row.id),
    tickerOrTopic: row.ticker_or_topic,
    detectedAt: row.detected_at,
    mentionCount: row.mention_count,
    volumeZ: row.volume_z,
    sentimentZ: row.sentiment_z,
    currentSentiment: row.current_sentiment,
    baselineAvgVolume: row.baseline_avg_volume,
    kind: row.kind,
    alertThreshold: row.alert_threshold,
    lastAlertedAt: row.last_alerted_at,
  }));
}

export type AlertRecord = {
  spikeId: number;
  tickerOrTopic: string;
  destinationMasked: string;
  body: string;
  providerMessageId?: string | null;
  error?: string | null;
};

/**
 * Records an alert and stamps the watchlist cooldown, in one transaction.
 *
 * Returns false when this spike already had an SMS -- the unique constraint,
 * not a prior read, is what prevents a double send.
 */
export async function recordAlert(pool: Pool, record: AlertRecord): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const { rowCount } = await client.query(
      `insert into alerts
         (spike_id, ticker_or_topic, channel, destination_masked, body,
          provider_message_id, error)
       values ($1, $2, 'sms', $3, $4, $5, $6)
       on conflict (spike_id, channel) do nothing`,
      [
        record.spikeId,
        record.tickerOrTopic,
        record.destinationMasked,
        record.body,
        record.providerMessageId ?? null,
        record.error?.slice(0, 1000) ?? null,
      ],
    );

    if ((rowCount ?? 0) > 0 && !record.error) {
      await client.query(
        'update watchlist set last_alerted_at = now() where ticker_or_topic = $1',
        [record.tickerOrTopic],
      );
    }
    await client.query('commit');
    return (rowCount ?? 0) > 0;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

/** Successful sends in the last 24h, for the spend guard. */
export async function countAlertsToday(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `select count(*) from alerts
      where error is null and sent_at >= now() - interval '24 hours'`,
  );
  return Number(rows[0]?.count ?? 0);
}

export type SentAlert = {
  tickerOrTopic: string;
  body: string;
  sentAt: Date;
  error: string | null;
};

export async function recentAlerts(pool: Pool, limit = 20): Promise<SentAlert[]> {
  const { rows } = await pool.query<{
    ticker_or_topic: string;
    body: string;
    sent_at: Date;
    error: string | null;
  }>('select ticker_or_topic, body, sent_at, error from alerts order by sent_at desc limit $1', [
    limit,
  ]);
  return rows.map((row) => ({
    tickerOrTopic: row.ticker_or_topic,
    body: row.body,
    sentAt: row.sent_at,
    error: row.error,
  }));
}

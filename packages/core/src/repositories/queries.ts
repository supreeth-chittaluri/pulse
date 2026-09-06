import type { Pool } from 'pg';

/**
 * Read models for the API. Every query here is reachable anonymously, so each
 * one takes an explicit, server-capped limit -- no caller gets to ask for the
 * whole table.
 */

export type SignalRow = {
  id: number;
  postId: number;
  source: string;
  tickerOrTopic: string;
  sentimentScore: number;
  confidence: number | null;
  rawExcerpt: string;
  observedAt: Date;
  title: string;
  url: string;
};

export type SignalQuery = {
  ticker?: string;
  since?: Date;
  limit: number;
};

export async function selectSignals(pool: Pool, query: SignalQuery): Promise<SignalRow[]> {
  const { rows } = await pool.query<{
    id: string;
    post_id: string;
    source: string;
    ticker_or_topic: string;
    sentiment_score: number;
    confidence: number | null;
    raw_excerpt: string;
    observed_at: Date;
    title: string;
    url: string;
  }>(
    `select s.id, s.post_id, s.source, s.ticker_or_topic, s.sentiment_score,
            s.confidence, s.raw_excerpt,
            coalesce(p.posted_at, p.scraped_at) as observed_at, p.title, p.url
       from signals s
       join posts p on p.id = s.post_id
      where ($1::text is null or s.ticker_or_topic = $1)
        and ($2::timestamptz is null or coalesce(p.posted_at, p.scraped_at) >= $2)
      order by observed_at desc, s.id desc
      limit $3`,
    [query.ticker ?? null, query.since ?? null, query.limit],
  );

  return rows.map((row) => ({
    id: Number(row.id),
    postId: Number(row.post_id),
    source: row.source,
    tickerOrTopic: row.ticker_or_topic,
    sentimentScore: row.sentiment_score,
    confidence: row.confidence,
    rawExcerpt: row.raw_excerpt,
    observedAt: row.observed_at,
    title: row.title,
    url: row.url,
  }));
}

export type TickerSummary = {
  tickerOrTopic: string;
  mentions: number;
  avgSentiment: number;
  lastSeenAt: Date;
  baselineAvgSentiment: number | null;
  baselineAvgVolume: number | null;
  /**
   * Hourly mention counts for the last 24h, oldest first, zero-filled.
   *
   * Returned with the list so a table of 25 tickers can draw 25 sparklines from
   * one query instead of 25 round trips.
   */
  series: number[];
};

const SPARK_HOURS = 24;

export async function selectTickerSummaries(
  pool: Pool,
  limit: number,
): Promise<TickerSummary[]> {
  const { rows } = await pool.query<{
    ticker_or_topic: string;
    mentions: string;
    avg_sentiment: number;
    last_seen_at: Date;
    rolling_avg: number | null;
    rolling_avg_volume: number | null;
    series: string[] | null;
  }>(
    `with observed as (
       select s.ticker_or_topic,
              s.sentiment_score,
              coalesce(p.posted_at, p.scraped_at) as observed_at
         from signals s
         join posts p on p.id = s.post_id
     ),
     summary as (
       select ticker_or_topic,
              count(*)             as mentions,
              avg(sentiment_score) as avg_sentiment,
              max(observed_at)     as last_seen_at
         from observed
        group by ticker_or_topic
        order by count(*) desc
        limit $1
     ),
     hours as (
       select generate_series(
         date_trunc('hour', now()) - make_interval(hours => $2 - 1),
         date_trunc('hour', now()),
         interval '1 hour'
       ) as bucket
     ),
     hourly as (
       select ticker_or_topic, date_trunc('hour', observed_at) as bucket, count(*) as n
         from observed
        where observed_at >= date_trunc('hour', now()) - make_interval(hours => $2 - 1)
        group by 1, 2
     )
     select su.ticker_or_topic,
            su.mentions,
            su.avg_sentiment,
            su.last_seen_at,
            b.rolling_avg,
            b.rolling_avg_volume,
            -- Zero-filled so a sparkline shows real gaps rather than silently
            -- closing them up, and so every series has the same length.
            (select array_agg(coalesce(h.n, 0) order by hours.bucket)
               from hours
               left join hourly h
                 on h.bucket = hours.bucket
                and h.ticker_or_topic = su.ticker_or_topic) as series
       from summary su
       left join baselines b on b.ticker_or_topic = su.ticker_or_topic
      order by su.mentions desc`,
    [limit, SPARK_HOURS],
  );

  return rows.map((row) => ({
    tickerOrTopic: row.ticker_or_topic,
    mentions: Number(row.mentions),
    avgSentiment: Number(row.avg_sentiment),
    lastSeenAt: row.last_seen_at,
    baselineAvgSentiment: row.rolling_avg,
    baselineAvgVolume: row.rolling_avg_volume,
    series: (row.series ?? []).map(Number),
  }));
}

export type TrendPoint = { bucket: Date; mentions: number; avgSentiment: number };

/**
 * Hourly series for one ticker.
 *
 * Bucketed by when the post was MADE, not when it happened to be scored.
 * Scoring runs on demand and can clear a backlog of hundreds in one pass; using
 * the scoring time would collapse a week of activity into a single bar and
 * invent a spike that never happened.
 */
export async function selectTickerTrend(
  pool: Pool,
  ticker: string,
  hours: number,
): Promise<TrendPoint[]> {
  const { rows } = await pool.query<{ bucket: Date; mentions: string; avg_sentiment: number }>(
    `select date_trunc('hour', coalesce(p.posted_at, s.scraped_at)) as bucket,
            count(*)                                                as mentions,
            avg(s.sentiment_score)                                  as avg_sentiment
       from signals s
       join posts p on p.id = s.post_id
      where s.ticker_or_topic = $1
        and coalesce(p.posted_at, s.scraped_at) >= now() - make_interval(hours => $2)
      group by 1
      order by 1 asc`,
    [ticker, hours],
  );
  return rows.map((row) => ({
    bucket: row.bucket,
    mentions: Number(row.mentions),
    avgSentiment: Number(row.avg_sentiment),
  }));
}

export type Stats = {
  posts: number;
  signals: number;
  tickers: number;
  spikes: number;
  lastIngestAt: Date | null;
  lastSignalAt: Date | null;
};

export async function selectStats(pool: Pool): Promise<Stats> {
  const { rows } = await pool.query<{
    posts: string;
    signals: string;
    tickers: string;
    spikes: string;
    last_ingest_at: Date | null;
    last_signal_at: Date | null;
  }>(
    `select (select count(*) from posts)                          as posts,
            (select count(*) from signals)                        as signals,
            (select count(distinct ticker_or_topic) from signals) as tickers,
            (select count(*) from spikes)                         as spikes,
            (select max(scraped_at) from posts)                   as last_ingest_at,
            (select max(scraped_at) from signals)                 as last_signal_at`,
  );
  const row = rows[0]!;
  return {
    posts: Number(row.posts),
    signals: Number(row.signals),
    tickers: Number(row.tickers),
    spikes: Number(row.spikes),
    lastIngestAt: row.last_ingest_at,
    lastSignalAt: row.last_signal_at,
  };
}

export type WatchlistEntry = {
  tickerOrTopic: string;
  alertThreshold: number;
  smsTo: string | null;
  lastAlertedAt: Date | null;
};

export async function selectWatchlist(pool: Pool): Promise<WatchlistEntry[]> {
  const { rows } = await pool.query<{
    ticker_or_topic: string;
    alert_threshold: number;
    sms_to: string | null;
    last_alerted_at: Date | null;
  }>('select ticker_or_topic, alert_threshold, sms_to, last_alerted_at from watchlist order by 1');
  return rows.map((row) => ({
    tickerOrTopic: row.ticker_or_topic,
    alertThreshold: row.alert_threshold,
    smsTo: row.sms_to,
    lastAlertedAt: row.last_alerted_at,
  }));
}

export async function upsertWatchlistEntry(
  pool: Pool,
  tickerOrTopic: string,
  alertThreshold: number,
): Promise<void> {
  await pool.query(
    `insert into watchlist (ticker_or_topic, alert_threshold)
     values ($1, $2)
     on conflict (ticker_or_topic) do update set alert_threshold = excluded.alert_threshold`,
    [tickerOrTopic, alertThreshold],
  );
}

export async function deleteWatchlistEntry(pool: Pool, tickerOrTopic: string): Promise<boolean> {
  const { rowCount } = await pool.query('delete from watchlist where ticker_or_topic = $1', [
    tickerOrTopic,
  ]);
  return (rowCount ?? 0) > 0;
}

/** Signals newer than a cursor, oldest first. Drives the live stream. */
export async function selectSignalsAfterId(
  pool: Pool,
  afterId: number,
  limit: number,
): Promise<SignalRow[]> {
  const { rows } = await pool.query<{
    id: string;
    post_id: string;
    source: string;
    ticker_or_topic: string;
    sentiment_score: number;
    confidence: number | null;
    raw_excerpt: string;
    observed_at: Date;
    title: string;
    url: string;
  }>(
    `select s.id, s.post_id, s.source, s.ticker_or_topic, s.sentiment_score,
            s.confidence, s.raw_excerpt,
            coalesce(p.posted_at, p.scraped_at) as observed_at, p.title, p.url
       from signals s
       join posts p on p.id = s.post_id
      where s.id > $1
      order by s.id asc
      limit $2`,
    [afterId, limit],
  );
  return rows.map((row) => ({
    id: Number(row.id),
    postId: Number(row.post_id),
    source: row.source,
    tickerOrTopic: row.ticker_or_topic,
    sentimentScore: row.sentiment_score,
    confidence: row.confidence,
    rawExcerpt: row.raw_excerpt,
    observedAt: row.observed_at,
    title: row.title,
    url: row.url,
  }));
}

export type MaxIds = { signalId: number; spikeId: number };

export async function selectMaxIds(pool: Pool): Promise<MaxIds> {
  const { rows } = await pool.query<{ signal_id: string | null; spike_id: string | null }>(
    `select (select max(id) from signals) as signal_id,
            (select max(id) from spikes)  as spike_id`,
  );
  return {
    signalId: Number(rows[0]?.signal_id ?? 0),
    spikeId: Number(rows[0]?.spike_id ?? 0),
  };
}

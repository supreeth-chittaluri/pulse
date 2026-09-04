import type { Pool } from 'pg';

export type UnscoredPost = {
  id: number;
  source: string;
  title: string;
  body: string | null;
};

/** Posts waiting to be scored, oldest first, skipping ones that keep failing. */
export async function selectUnscoredPosts(
  pool: Pool,
  limit: number,
  maxAttempts = 3,
): Promise<UnscoredPost[]> {
  const { rows } = await pool.query<{
    id: string;
    source: string;
    title: string;
    body: string | null;
  }>(
    `select id, source, title, body
       from posts
      where scored_at is null and score_attempts < $2
      order by scraped_at asc
      limit $1`,
    [limit, maxAttempts],
  );
  return rows.map((r) => ({ id: Number(r.id), source: r.source, title: r.title, body: r.body }));
}

export async function countUnscoredPosts(pool: Pool, maxAttempts = 3): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    'select count(*) from posts where scored_at is null and score_attempts < $1',
    [maxAttempts],
  );
  return Number(rows[0]?.count ?? 0);
}

export type SignalInput = {
  tickerOrTopic: string;
  sentimentScore: number;
  confidence: number;
  rawExcerpt: string;
};

/**
 * Writes a post's signals and marks it scored, in ONE transaction.
 *
 * The atomicity matters: if scored_at were set separately and the process died
 * in between, the post would be permanently marked done with no signals and
 * nothing would ever notice. A post with no ticker mentions legitimately
 * produces zero signals -- that is a successful scoring, not a failure.
 */
export async function writeScores(
  pool: Pool,
  postId: number,
  source: string,
  signals: SignalInput[],
): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('begin');

    let inserted = 0;
    for (const signal of signals) {
      const { rowCount } = await client.query(
        `insert into signals
           (post_id, source, ticker_or_topic, sentiment_score, confidence, raw_excerpt)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (post_id, ticker_or_topic) do nothing`,
        [
          postId,
          source,
          signal.tickerOrTopic,
          signal.sentimentScore,
          signal.confidence,
          signal.rawExcerpt,
        ],
      );
      inserted += rowCount ?? 0;
    }

    await client.query(
      'update posts set scored_at = now(), score_error = null where id = $1',
      [postId],
    );
    await client.query('commit');
    return inserted;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

/** Records a failed scoring attempt so a poison post eventually drops out. */
export async function recordScoreFailure(
  pool: Pool,
  postIds: number[],
  error: string,
): Promise<void> {
  if (postIds.length === 0) return;
  await pool.query(
    `update posts
        set score_attempts = score_attempts + 1,
            score_error = $2
      where id = any($1::bigint[])`,
    [postIds, error.slice(0, 1000)],
  );
}

export type LlmRequestRecord = {
  provider: string;
  model: string;
  postsInBatch: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
  durationMs?: number | null;
  error?: string | null;
};

export async function recordLlmRequest(pool: Pool, record: LlmRequestRecord): Promise<void> {
  await pool.query(
    `insert into llm_requests
       (provider, model, posts_in_batch, input_tokens, output_tokens, duration_ms, error)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      record.provider,
      record.model,
      record.postsInBatch,
      record.inputTokens ?? null,
      record.outputTokens ?? null,
      record.durationMs ?? null,
      record.error?.slice(0, 1000) ?? null,
    ],
  );
}

/**
 * Requests made so far in the current quota day.
 *
 * Gemini's free-tier daily quota resets at midnight Pacific, not UTC and not
 * local time, so the window is computed in America/Los_Angeles -- otherwise the
 * local budget and the real quota would drift apart by up to eight hours and
 * the guard would be useless exactly when it mattered.
 */
export async function countRequestsToday(pool: Pool, provider: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `select count(*)
       from llm_requests
      where provider = $1
        and requested_at >= date_trunc('day', now() at time zone 'America/Los_Angeles')
                            at time zone 'America/Los_Angeles'`,
    [provider],
  );
  return Number(rows[0]?.count ?? 0);
}

export async function countSignals(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ count: string }>('select count(*) from signals');
  return Number(rows[0]?.count ?? 0);
}

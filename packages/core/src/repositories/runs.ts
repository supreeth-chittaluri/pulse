import type { Pool } from 'pg';

export type FinishRunInput = {
  postsFetched: number;
  postsInserted: number;
  error?: string | null;
};

/** Opens an ingest_runs row before the fetch, so a crashed run is still visible. */
export async function startRun(pool: Pool, source: string, adapter: string): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    'insert into ingest_runs (source, adapter) values ($1, $2) returning id',
    [source, adapter],
  );
  return Number(rows[0]!.id);
}

export async function finishRun(pool: Pool, id: number, input: FinishRunInput): Promise<void> {
  await pool.query(
    `update ingest_runs
        set finished_at = now(),
            posts_fetched = $2,
            posts_inserted = $3,
            error = $4
      where id = $1`,
    [id, input.postsFetched, input.postsInserted, input.error ?? null],
  );
}

export type LastRun = {
  source: string;
  adapter: string;
  startedAt: Date;
  finishedAt: Date | null;
  postsFetched: number | null;
  postsInserted: number | null;
  error: string | null;
};

/** Most recent run per source. Feeds `worker status` and, later, /health. */
export async function lastRunPerSource(pool: Pool): Promise<LastRun[]> {
  const { rows } = await pool.query<{
    source: string;
    adapter: string;
    started_at: Date;
    finished_at: Date | null;
    posts_fetched: number | null;
    posts_inserted: number | null;
    error: string | null;
  }>(
    `select distinct on (source)
            source, adapter, started_at, finished_at, posts_fetched, posts_inserted, error
       from ingest_runs
      order by source, started_at desc`,
  );
  return rows.map((row) => ({
    source: row.source,
    adapter: row.adapter,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    postsFetched: row.posts_fetched,
    postsInserted: row.posts_inserted,
    error: row.error,
  }));
}

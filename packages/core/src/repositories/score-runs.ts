import type { Pool } from 'pg';

const SCORE_RUN_LOCK = 741_205_019;
const STALE_RUN_MINUTES = 5;

export type ScoreRunStatus = {
  usedToday: number;
  resetAt: Date;
  running: boolean;
};

export type ScoreRunReservation =
  | ({ state: 'reserved'; runId: number } & ScoreRunStatus)
  | ({ state: 'limit_reached' } & ScoreRunStatus)
  | ({ state: 'in_progress' } & ScoreRunStatus);

/**
 * Returns usage for the Gemini quota day. Gemini resets at midnight Pacific,
 * including daylight-saving changes, so the database computes both bounds in
 * America/Los_Angeles rather than assuming a fixed UTC offset.
 */
export async function scoreRunStatus(pool: Pool): Promise<ScoreRunStatus> {
  const { rows } = await pool.query<{
    used_today: string;
    reset_at: Date;
    running: boolean;
  }>(
    `with bounds as (
       select date_trunc('day', now() at time zone 'America/Los_Angeles')
                at time zone 'America/Los_Angeles' as starts_at,
              (date_trunc('day', now() at time zone 'America/Los_Angeles') + interval '1 day')
                at time zone 'America/Los_Angeles' as reset_at
     )
     select count(*) filter (where sr.requested_at >= b.starts_at) as used_today,
            b.reset_at,
            coalesce(bool_or(
              sr.completed_at is null
              and sr.requested_at >= now() - make_interval(mins => $1)
            ), false) as running
       from bounds b
       left join score_runs sr on sr.requested_at >= b.starts_at
      group by b.reset_at`,
    [STALE_RUN_MINUTES],
  );
  const row = rows[0]!;
  return {
    usedToday: Number(row.used_today),
    resetAt: row.reset_at,
    running: row.running,
  };
}

/**
 * Atomically reserves one app-wide scoring run.
 *
 * The transaction-scoped advisory lock serializes the read-and-insert across
 * every API instance. It is held only for the short reservation transaction,
 * which is safe with pooled Postgres connections and never wraps the external
 * Gemini request.
 */
export async function reserveScoreRun(
  pool: Pool,
  dailyLimit: number,
): Promise<ScoreRunReservation> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock($1)', [SCORE_RUN_LOCK]);

    const { rows } = await client.query<{
      used_today: string;
      reset_at: Date;
      running: boolean;
    }>(
      `with bounds as (
         select date_trunc('day', now() at time zone 'America/Los_Angeles')
                  at time zone 'America/Los_Angeles' as starts_at,
                (date_trunc('day', now() at time zone 'America/Los_Angeles') + interval '1 day')
                  at time zone 'America/Los_Angeles' as reset_at
       )
       select count(*) filter (where sr.requested_at >= b.starts_at) as used_today,
              b.reset_at,
              coalesce(bool_or(
                sr.completed_at is null
                and sr.requested_at >= now() - make_interval(mins => $1)
              ), false) as running
         from bounds b
         left join score_runs sr on sr.requested_at >= b.starts_at
        group by b.reset_at`,
      [STALE_RUN_MINUTES],
    );
    const status: ScoreRunStatus = {
      usedToday: Number(rows[0]!.used_today),
      resetAt: rows[0]!.reset_at,
      running: rows[0]!.running,
    };

    if (status.running) {
      await client.query('rollback');
      return { state: 'in_progress', ...status };
    }
    if (status.usedToday >= dailyLimit) {
      await client.query('rollback');
      return { state: 'limit_reached', ...status };
    }

    const inserted = await client.query<{ id: string }>(
      'insert into score_runs default values returning id',
    );
    await client.query('commit');
    return {
      state: 'reserved',
      runId: Number(inserted.rows[0]!.id),
      usedToday: status.usedToday + 1,
      resetAt: status.resetAt,
      running: true,
    };
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

export async function finishScoreRun(
  pool: Pool,
  runId: number,
  error?: string,
): Promise<void> {
  await pool.query(
    `update score_runs
        set completed_at = now(), error = $2
      where id = $1`,
    [runId, error?.slice(0, 1000) ?? null],
  );
}

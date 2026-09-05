import type { Pool } from 'pg';

const SCORE_RUN_LOCK = 741_205_019;
const STALE_RUN_MINUTES = 15;

export type ScoreRunKind = 'manual' | 'automatic';

export type ScoreRunStatus = {
  usedToday: number;
  resetAt: Date;
  running: boolean;
  runningKind: ScoreRunKind | null;
  lastAutomaticRunAt: Date | null;
};

export type ScoreRunReservation =
  | ({ state: 'reserved'; runId: number } & ScoreRunStatus)
  | ({ state: 'limit_reached' } & ScoreRunStatus)
  | ({ state: 'in_progress' } & ScoreRunStatus);

export type AutomaticScoreRunReservation =
  | { state: 'reserved'; runId: number; scheduledFor: Date }
  | { state: 'in_progress'; runningKind: ScoreRunKind | null }
  | { state: 'already_ran' };

const STATUS_SQL = `with bounds as (
  select date_trunc('day', now() at time zone 'America/Los_Angeles')
           at time zone 'America/Los_Angeles' as starts_at,
         (date_trunc('day', now() at time zone 'America/Los_Angeles') + interval '1 day')
           at time zone 'America/Los_Angeles' as reset_at
), active as (
  select kind from score_runs
   where completed_at is null
     and requested_at >= now() - make_interval(mins => $1)
   order by requested_at desc limit 1
)
select count(*) filter (
         where sr.kind = 'manual' and sr.requested_at >= b.starts_at
       ) as used_today,
       b.reset_at,
       exists(select 1 from active) as running,
       (select kind from active) as running_kind,
       (select max(requested_at) from score_runs where kind = 'automatic') as last_automatic_run_at
  from bounds b
  left join score_runs sr on sr.requested_at >= b.starts_at
 group by b.reset_at`;

function mapStatus(row: {
  used_today: string;
  reset_at: Date;
  running: boolean;
  running_kind: ScoreRunKind | null;
  last_automatic_run_at: Date | null;
}): ScoreRunStatus {
  return {
    usedToday: Number(row.used_today),
    resetAt: row.reset_at,
    running: row.running,
    runningKind: row.running_kind,
    lastAutomaticRunAt: row.last_automatic_run_at,
  };
}

/** Usage and run state for both manual and automatic scoring. */
export async function scoreRunStatus(pool: Pool): Promise<ScoreRunStatus> {
  const { rows } = await pool.query<{
    used_today: string;
    reset_at: Date;
    running: boolean;
    running_kind: ScoreRunKind | null;
    last_automatic_run_at: Date | null;
  }>(STATUS_SQL, [STALE_RUN_MINUTES]);
  return mapStatus(rows[0]!);
}

/** Atomically reserves one app-wide manual scoring run. */
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
      running_kind: ScoreRunKind | null;
      last_automatic_run_at: Date | null;
    }>(STATUS_SQL, [STALE_RUN_MINUTES]);
    const status = mapStatus(rows[0]!);

    if (status.running) {
      await client.query('rollback');
      return { state: 'in_progress', ...status };
    }
    if (status.usedToday >= dailyLimit) {
      await client.query('rollback');
      return { state: 'limit_reached', ...status };
    }

    const inserted = await client.query<{ id: string }>(
      "insert into score_runs (kind) values ('manual') returning id",
    );
    await client.query('commit');
    return {
      state: 'reserved',
      runId: Number(inserted.rows[0]!.id),
      ...status,
      usedToday: status.usedToday + 1,
      running: true,
      runningKind: 'manual',
    };
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

/** Reserves the current schedule slot and shares the manual-run lock. */
export async function reserveAutomaticScoreRun(
  pool: Pool,
  intervalMinutes: number,
): Promise<AutomaticScoreRunReservation> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock($1)', [SCORE_RUN_LOCK]);
    const active = await client.query<{ kind: ScoreRunKind }>(
      `select kind from score_runs
        where completed_at is null
          and requested_at >= now() - make_interval(mins => $1)
        order by requested_at desc limit 1`,
      [STALE_RUN_MINUTES],
    );
    if (active.rows[0]) {
      await client.query('rollback');
      return { state: 'in_progress', runningKind: active.rows[0].kind };
    }

    const slot = await client.query<{ scheduled_for: Date }>(
      `select to_timestamp(
         floor(extract(epoch from now()) / ($1 * 60)) * ($1 * 60)
       ) as scheduled_for`,
      [intervalMinutes],
    );
    const scheduledFor = slot.rows[0]!.scheduled_for;
    const inserted = await client.query<{ id: string }>(
      `insert into score_runs (kind, scheduled_for)
       values ('automatic', $1)
       on conflict (scheduled_for) where kind = 'automatic' do nothing
       returning id`,
      [scheduledFor],
    );
    if (!inserted.rows[0]) {
      await client.query('rollback');
      return { state: 'already_ran' };
    }
    await client.query('commit');
    return { state: 'reserved', runId: Number(inserted.rows[0].id), scheduledFor };
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
    'update score_runs set completed_at = now(), error = $2 where id = $1',
    [runId, error?.slice(0, 1000) ?? null],
  );
}

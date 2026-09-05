-- Automatic scoring: durable local triage plus coordinated scheduled runs.

-- Triage is deliberately persisted. A restart can resume the queue without
-- redoing work, and posts with no plausible ticker are completed without ever
-- consuming a Gemini request.
alter table posts add column if not exists triaged_at timestamptz;
alter table posts add column if not exists scoring_candidates jsonb;

drop index if exists posts_scoring_queue_idx;
create index if not exists posts_triage_queue_idx
  on posts (scraped_at)
  where scored_at is null and triaged_at is null and score_attempts < 3;
create index if not exists posts_gemini_queue_idx
  on posts (scraped_at)
  where scored_at is null and triaged_at is not null and score_attempts < 3;

alter table score_runs
  add column if not exists kind text not null default 'manual';
alter table score_runs
  add column if not exists scheduled_for timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'score_runs_kind_check'
  ) then
    alter table score_runs add constraint score_runs_kind_check
      check (kind in ('manual', 'automatic'));
  end if;
end $$;

-- One durable reservation per schedule slot prevents duplicate automatic runs
-- after restarts or when more than one API instance is briefly alive.
create unique index if not exists score_runs_automatic_slot_idx
  on score_runs (scheduled_for)
  where kind = 'automatic';

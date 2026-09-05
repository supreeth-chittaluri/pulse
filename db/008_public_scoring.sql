-- Public, manually-triggered scoring runs.
--
-- Every accepted button press is recorded before Gemini is called. This makes
-- the ten-runs-per-day limit global and durable across browsers, IP addresses,
-- process restarts, and multiple API instances.
create table if not exists score_runs (
  id           bigserial   primary key,
  requested_at timestamptz not null default now(),
  completed_at timestamptz,
  error        text
);

create index if not exists score_runs_requested_at_idx
  on score_runs (requested_at desc);

-- Status checks use this partial index to reject overlapping runs. A run older
-- than five minutes is treated as abandoned; the row still counts toward the
-- daily cap, but it cannot block the button forever after a crashed process.
create index if not exists score_runs_in_progress_idx
  on score_runs (requested_at desc)
  where completed_at is null;

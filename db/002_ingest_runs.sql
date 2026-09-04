-- M1: one row per attempted fetch of one source.
--
-- Not in the original spec. It earns its place three times over: it makes
-- "a scheduled run happened" observable instead of inferred from logs, it is
-- where M9's posts/day resume metric comes from, and M4/M8 can expose
-- last-successful-run per source on /health.

create table if not exists ingest_runs (
  id             bigserial   primary key,
  source         text        not null,
  adapter        text        not null,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  posts_fetched  integer,
  posts_inserted integer,
  error          text
);

-- "when did this source last succeed / last run at all"
create index if not exists ingest_runs_source_started_idx
  on ingest_runs (source, started_at desc);

-- M9 aggregates volume over time across all sources.
create index if not exists ingest_runs_started_idx on ingest_runs (started_at desc);

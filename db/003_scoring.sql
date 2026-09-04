-- M2: sentiment scoring state.

-- Stop retrying a post that keeps failing (unparseable body, model refusal,
-- schema violation). The scoring queue skips anything past the attempt limit.
alter table posts add column if not exists score_attempts integer not null default 0;
alter table posts add column if not exists score_error    text;

drop index if exists posts_unscored_idx;
create index if not exists posts_scoring_queue_idx
  on posts (scraped_at)
  where scored_at is null and score_attempts < 3;

-- One row per model request. The free tier is a hard daily quota rather than a
-- bill, so we meter ourselves against it locally instead of discovering the
-- ceiling by hitting 429s.
create table if not exists llm_requests (
  id             bigserial   primary key,
  provider       text        not null,
  model          text        not null,
  requested_at   timestamptz not null default now(),
  posts_in_batch integer     not null,
  input_tokens   integer,
  output_tokens  integer,
  duration_ms    integer,
  error          text
);

create index if not exists llm_requests_requested_at_idx on llm_requests (requested_at desc);

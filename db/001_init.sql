-- M0: initial schema.
--
-- Note the posts/signals split. The original spec had a single `signals` table
-- carrying one ticker, but a post routinely mentions several tickers and M1's
-- dedupe key is the *post*. So:
--   posts   -- raw ingested content, one row per source post (M1 dedupes here)
--   signals -- one row per (post x ticker), scored by Claude in M2

create table if not exists posts (
  id             bigserial   primary key,
  source         text        not null,
  source_post_id text        not null,
  title          text        not null,
  body           text,
  url            text        not null,
  author         text,
  posted_at      timestamptz,
  scraped_at     timestamptz not null default now(),
  scored_at      timestamptz,
  constraint posts_source_post_unique unique (source, source_post_id)
);

-- M2 pulls its work queue off this index.
create index if not exists posts_unscored_idx on posts (scraped_at) where scored_at is null;
create index if not exists posts_posted_at_idx on posts (posted_at desc nulls last);

create table if not exists signals (
  id              bigserial    primary key,
  post_id         bigint       not null references posts (id) on delete cascade,
  source          text         not null,
  ticker_or_topic text         not null,
  sentiment_score numeric(4,3) not null check (sentiment_score between -1 and 1),
  confidence      numeric(4,3) check (confidence between 0 and 1),
  raw_excerpt     text         not null,
  scraped_at      timestamptz  not null default now(),
  constraint signals_post_ticker_unique unique (post_id, ticker_or_topic)
);

-- M3 reads baselines over this; M5/M6 read the live feed over it too.
create index if not exists signals_ticker_time_idx on signals (ticker_or_topic, scraped_at desc);

create table if not exists baselines (
  ticker_or_topic text         primary key,
  rolling_avg     numeric(6,4) not null,
  rolling_stddev  numeric(6,4) not null,
  sample_count    integer      not null default 0,
  window_hours    integer      not null default 168,
  updated_at      timestamptz  not null default now()
);

create table if not exists watchlist (
  ticker_or_topic text         primary key,
  alert_threshold numeric(4,2) not null default 2.5,  -- z-score, see M3
  sms_to          text,
  last_alerted_at timestamptz,
  created_at      timestamptz  not null default now()
);

create table if not exists users (
  id            bigserial   primary key,
  email         text        not null unique,
  role          text        not null check (role in ('demo', 'admin')),
  password_hash text        not null,
  created_at    timestamptz not null default now()
);

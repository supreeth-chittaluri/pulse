-- M3: rolling baselines and spike detection.

-- baselines already carries the sentiment pair (rolling_avg / rolling_stddev).
-- Volume gets its own pair: a sentiment swing on two mentions is noise, and a
-- volume surge with flat sentiment is usually just a news event. The signal
-- worth alerting on is the two together.
alter table baselines add column if not exists rolling_avg_volume    numeric(8,4);
alter table baselines add column if not exists rolling_stddev_volume numeric(8,4);
alter table baselines add column if not exists bucket_count          integer not null default 0;

-- A ticker can have enough history for a volume baseline but not a sentiment
-- one (or the reverse), so neither pair can be mandatory any more.
alter table baselines alter column rolling_avg    drop not null;
alter table baselines alter column rolling_stddev drop not null;

create table if not exists spikes (
  id                     bigserial   primary key,
  ticker_or_topic        text        not null,
  detected_at            timestamptz not null default now(),
  -- The window that spiked, not the baseline window.
  window_start           timestamptz not null,
  window_end             timestamptz not null,
  mention_count          integer     not null,
  volume_z               numeric(8,4) not null,
  sentiment_z            numeric(8,4),
  current_sentiment      numeric(4,3),
  baseline_avg_volume    numeric(8,4) not null,
  baseline_avg_sentiment numeric(4,3),
  kind                   text        not null check (kind in ('volume', 'volume+sentiment')),

  -- Re-running detection over the same window must not duplicate a spike.
  constraint spikes_unique_window unique (ticker_or_topic, window_start)
);

create index if not exists spikes_detected_idx on spikes (detected_at desc);
create index if not exists spikes_ticker_idx   on spikes (ticker_or_topic, detected_at desc);

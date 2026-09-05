-- M7: SMS alerting.

create table if not exists alerts (
  id                  bigserial   primary key,
  spike_id            bigint      not null references spikes (id) on delete cascade,
  ticker_or_topic     text        not null,
  channel             text        not null check (channel in ('sms')),
  -- Masked at write time (e.g. "+1******4821"). The real destination lives in
  -- .env; there is no reason for the database to hold a phone number in clear.
  destination_masked  text        not null,
  body                text        not null,
  sent_at             timestamptz not null default now(),
  provider_message_id text,
  error               text,

  -- The idempotency guarantee. One spike can produce at most one SMS, so a
  -- restart, a re-run, or a retry cannot text you twice about the same event.
  constraint alerts_unique_spike_channel unique (spike_id, channel)
);

create index if not exists alerts_sent_at_idx on alerts (sent_at desc);
create index if not exists alerts_ticker_idx  on alerts (ticker_or_topic, sent_at desc);

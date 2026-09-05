-- M5: publish row inserts so the API can push them to connected browsers.
--
-- Done with a trigger rather than an application-level notify call, so EVERY
-- writer publishes: the worker, POST /api/scoring/run, M7's alerting, and any
-- manual insert. An app-level publish is a thing someone forgets exactly once,
-- after which the stream is quietly incomplete.
--
-- The payload is only the row id -- NOTIFY caps at 8000 bytes, and the API
-- re-queries anyway so it can batch a burst into one round trip. In fact the
-- id is just a wake-up: the hub tracks its own cursor, which makes a dropped
-- notification harmless rather than a permanently missed row.

create or replace function pulse_notify_insert() returns trigger
language plpgsql as $$
begin
  perform pg_notify(tg_argv[0], new.id::text);
  return null;
end;
$$;

drop trigger if exists signals_notify_insert on signals;
create trigger signals_notify_insert
  after insert on signals
  for each row execute function pulse_notify_insert('pulse_signal');

drop trigger if exists spikes_notify_insert on spikes;
create trigger spikes_notify_insert
  after insert on spikes
  for each row execute function pulse_notify_insert('pulse_spike');

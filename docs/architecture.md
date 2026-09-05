# Architecture

How pulse is built, and why each piece is the way it is. Where a decision was
measured rather than assumed, the measurement is here too.

```
  RSS / Reddit / HN / Google News
             │
             ▼
      ┌─────────────┐   dedupe on (source, source_post_id)
      │  ingestion  │──────────────────────────────► posts
      └─────────────┘
             │
             ▼
      ┌─────────────┐   free regex + allowlist; durable result
      │   triage    │──────────────► candidate queue
      └─────────────┘                         │
                                            ▼
      ┌─────────────┐   Gemini every 30 min → Zod
      │   scoring   │──────────────────────────────► signals
      └─────────────┘
             │
             ▼
      ┌─────────────┐   rolling per-ticker baseline, z-score
      │  detection  │──────────────────────────────► spikes
      └─────────────┘
             │                                         │
             ▼                                         ▼
      ┌─────────────┐                           ┌─────────────┐
      │  API + SPA  │◄── SSE / polling ────────►│  alerting   │
      └─────────────┘                           └─────────────┘
```

Four workspace packages (`core`, `sources`, `scoring`, `analysis`, `alerting`)
and two apps (`api`, `web`). TypeScript throughout, run directly by Node's
native type stripping — no build step outside the browser bundle.

---

## Ingestion

**Sources sit behind one interface.** Reddit closed self-service OAuth
registration in late 2025, and no milestone could be allowed to depend on an
approval landing. Every source implements `fetch(): Promise<RawPost[]>`, and the
registry picks the public `.rss` adapter or the OAuth one purely on whether
credentials exist. Both emit the same `sourcePostId` (the Reddit fullname), so
switching later re-ingests nothing.

**Reddit's rate limit is per client, not per feed.** Measured: three
back-to-back fetches of *different* subreddits return 429. So every Reddit
adapter shares one `MinIntervalGate` bucket at one request per 60s, and the
config enforces a 600s floor on Reddit poll intervals.

**Dedupe is a constraint, not a check.** `posts` is unique on
`(source, source_post_id)` and inserts use `ON CONFLICT DO NOTHING RETURNING id`.
No read-then-write, so re-running is a no-op and concurrent workers cannot race.

---

## Scoring

**The model does not find tickers.** A regex plus an allowlist of real listed
symbols proposes candidates; the model only judges whether each is genuinely a
ticker mention in context and how the post feels about it. Two consequences:
the expensive step gets smaller, and the cheap step is unit-testable.

Measured on 575 real posts: **45% were filtered out locally**, never reaching the
model. On a 60-post production batch it was 50%.

The filter result is stored on each post. This makes the Postgres-backed queue
durable across deploys and separates two useful health numbers: raw posts still
awaiting the free filter, and genuine ticker candidates awaiting Gemini. Posts
with no candidates are marked complete immediately.

Scoring reserves one automatic run per 30-minute database time slot and handles
up to 60 candidate posts. Manual and automatic runs use the same advisory lock,
so they cannot overlap. The public **Score now** control is an optional catch-up
path, not the scheduler.

The allowlist comes from the SEC's `company_tickers.json`, which contains
**operating companies only, no ETFs** — so a curated ETF list is merged in.
Without it `SPY`, `QQQ` and `IWM`, three of the most-discussed symbols on these
subreddits, are invisible. A stoplist suppresses real symbols that are ordinary
words (`DD`, `IT`, `OPEN`, `A`) unless written as a cashtag.

**Validation is ours, not the provider's.** Gemini's structured output honours
only a subset of JSON Schema — notably it does not enforce numeric bounds — so
the API schema constrains shape only and every range is re-checked with Zod.
Beyond the schema, the set of `post_id`s returned must exactly match the set
sent: batching 15 posts invites the model to drop, duplicate or invent an entry,
and a shuffled result would attach one post's sentiment to another post's row
with nothing downstream able to notice.

---

## Spike detection

Two z-scores per ticker. Volume is the gate — a sentiment swing measured over
two mentions is noise — and sentiment classifies the result.

Three things decide whether this works at all:

**The baseline excludes the window it judges.** Otherwise a spike raises the
mean and inflates the spread, suppressing its own z-score: the bigger the event,
the less it fires.

**Sentiment divides by standard error, not standard deviation.** It compares a
*mean* of n observations, which is √n times less noisy than a single one. A real
+0.6 swing against an individual-level σ of 0.4 reads as a forgettable z=1.5 the
naive way and z=4.7 correctly.

**Volume baselines count empty hours.** Averaging only hours that contain data
answers "mentions per hour in which this ticker is mentioned at all" — close to
1 for everything, and useless.

Guards: a Poisson variance floor so a week of zeros cannot score infinity on one
mention, a 20-observation/3-bucket minimum before a baseline exists, a
5-mention absolute floor, and a 6-hour per-ticker cooldown. Google News is
excluded from the volume baseline (fixed polling cadence shrinks the variance)
but kept for sentiment, where cadence distorts nothing.

---

## Real-time transport

SSE is the right primitive — one-directional, plain HTTP, `EventSource`
reconnects itself. **It works on the deployment**: measured in a browser against
production, `open` at 91ms and the first `ready` event at 148ms, and
`/api/stream/selftest` chunks arrive progressively, 300ms apart, exactly as
written.

A polling fallback exists anyway, because a reverse proxy that buffers a
response until it completes makes SSE undeliverable — the server writes events,
the proxy holds every byte, and the browser sits on a connection that looks
open. That is a real and common hazard behind corporate proxies and some CDN
configurations, so the browser waits for an actual event rather than trusting
the connection, and switches to cursor-based polling of
`/api/signals?afterId=` after 6s.

> **A measurement error worth recording.** This fallback was built because I
> concluded the deployment *did* buffer. It does not. `curl` buffers its own
> stdout when that is a pipe rather than a terminal, and `timeout` killed it
> before it flushed — so a working stream read as zero bytes, and a progressive
> one read as a single burst at the end. A Node client and a browser both showed
> the truth immediately. The lesson: confirm a negative result with a second,
> independent client before building on it.

**Cross-process delivery** uses a database trigger calling `pg_notify`, so every
writer publishes — worker, admin endpoint, a manual insert — rather than each
remembering to. The payload is only a row id, and even that is just a wake-up:
the hub keeps its own cursor and re-queries, so a dropped notification is
harmless rather than a permanently missed row.

A transaction-mode pooler accepts `LISTEN` and never delivers, so the listener
probes at startup by notifying **from the pool** — the path a real trigger takes
— and degrades to polling if nothing arrives. An earlier version notified on the
listening connection itself, which a pooler permits, and so reported healthy on
exactly the configuration it existed to catch.

---

## API and auth

Three tiers: **anonymous** (all reads plus globally bounded manual scoring),
**demo** (the same capabilities plus a signed-in UI state), and **admin**
(watchlist mutations). Manual scoring is the deliberate exception to the
otherwise read-only public surface: ten app-wide runs per Pacific day, 60 posts
per run, and one active run at a time.

`requireRole('admin')` sits on the *mount*, not on individual routes, so a route
added later inherits the guard instead of needing to remember it.

Passwords use `node:crypto` scrypt with the cost parameters stored in the hash,
so they can be raised later without invalidating accounts. Login burns
comparable time and returns an identical response for an unknown account, so it
cannot enumerate emails. Production refuses to boot without a 32-character
`JWT_SECRET`.

The rate limiter is **in-process**: free hosting has no Redis and a
Postgres-backed counter means a write per request. It resets on restart and two
instances would each allow the full budget — correct for one small instance,
wrong the moment it scales.

---

## Spending money

Two resources can be spent: Gemini quota (a fixed daily allowance, so exhausting
it is a denial of service rather than a bill) and Twilio messages (actual money).

Every Gemini call reserves a row before contacting the provider. That single
transaction-locked reservation path is used by automatic batches, manual
batches, and validation retries, so concurrency cannot push the application
past its configured 400-request daily ceiling.

Every guard around them is deliberate, and the abuse audit is a **test** rather
than a checklist, because checklists get read once and then rot. It proves
coverage (every route is classified), behaviour (with `fetch` stubbed, no
anonymous or demo route makes any outbound request — on a *fully configured*
instance), and structure (the module graph from public routes never reaches
`@pulse/scoring` or `@pulse/alerting`).

Alerting adds four independent brakes: the watchlist opt-in, a kind filter
defaulting to `volume+sentiment` only, a per-ticker cooldown held in the
database *and* in memory within a run, and a rolling 24h budget. Not texting
twice is a unique constraint on `(spike_id, channel)`, not a prior read that
could race.

---

## What is deliberately not here

- **No external queue service.** At a few hundred posts a day, indexed Postgres
  rows are the durable queue. This survives restarts without adding Redis or a
  paid worker.
- **No ORM.** The queries are the interesting part; hiding them behind a
  builder would obscure the indexes they depend on.
- **No state library in the frontend.** The data model is small and the
  transport pushes it.
- **No background worker service in production.** Free tiers bill workers but
  not web services, so ingestion runs inside the API process. Locally the
  standalone worker is still preferred — it restarts independently.

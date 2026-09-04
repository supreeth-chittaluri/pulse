# pulse

Detects unusual sentiment spikes for US equities by continuously ingesting
retail and news chatter, scoring it with an LLM, and comparing each ticker
against its own rolling baseline.

> **Status: M2 complete.** Scheduled deduped ingestion, plus on-demand
> sentiment scoring on Gemini's free tier. Spike detection is next — see the
> milestone plan below.

---

## The problem

Sentiment on a ticker is only interesting relative to its own normal. r/stocks
mentions AAPL constantly; that's noise. r/stocks mentioning a small-cap forty
times in an hour when it normally gets two is signal. So pulse doesn't
threshold on raw sentiment — it maintains a per-ticker rolling baseline and
flags statistical deviations from it.

## Stack

| Layer | Choice |
| --- | --- |
| Language | TypeScript throughout, npm workspaces monorepo |
| Runtime | Node 22+ (uses native TypeScript type-stripping — no build step) |
| Database | Postgres 17 |
| Ingestion | RSS/Atom + Reddit OAuth, behind one `Source` interface |
| Scoring | Gemini Flash Lite (`gemini-3.5-flash-lite`) structured output, free tier |
| API | Express 5 |
| Tests | Vitest |

## Layout

```
config/sources.json    Which feeds to poll. Edit without touching code.
db/                    Schema migrations + idempotent runner
packages/core/         Config loading, Postgres pool, logging, shared types
packages/sources/      Source interface and its adapters
apps/worker/           Ingestion worker (CLI today, scheduled in M1)
apps/api/              Express API
```

## Quick start

```bash
cp .env.example .env      # defaults work as-is for local development
npm install
npm run db:up             # Postgres 17 in Docker, host port 5433
npm run db:migrate
```

Ingest:

```bash
npm run worker -- list-sources                 # what is configured, and via which adapter
npm run worker -- fetch-once --source reddit:stocks --limit 5   # print only, writes nothing
npm run worker -- ingest-once                  # one pass over every source, writes to Postgres
npm run worker -- run                          # poll on schedule until Ctrl-C
npm run worker -- status                       # stored counts and the last run per source
```

`ingest-once` paces itself through the Reddit gate, so a full pass takes about
four minutes: five Reddit sources at one request per minute. That is expected,
not a hang.

Verify the API:

```bash
npm run dev:api
curl localhost:3000/health
# {"status":"ok","db":"up","redditAdapter":"reddit-rss","sources":9,...}
```

Tests and typecheck:

```bash
npm test          # needs `npm run db:up`; DB-backed tests skip loudly without it
npm run typecheck
```

---

## Why ingestion is source-agnostic

Reddit closed self-service OAuth app registration in late 2025 under its
Responsible Builder policy — new clients now wait in a manual approval queue
with no guaranteed outcome. Blocking this project on that queue was not
acceptable, so every source implements one interface:

```ts
interface Source {
  readonly id: string;
  readonly adapter: string;
  readonly pollSeconds: number;
  fetch(): Promise<RawPost[]>;
}
```

Two Reddit adapters sit behind it:

| Adapter | Auth | Ceiling | Status |
| --- | --- | --- | --- |
| `reddit-rss` | none | ~50 posts/feed, no scores or comments | **active** |
| `reddit-oauth` | client credentials | 100 posts/call, scores, 100 QPM | dormant |

The registry picks between them purely on whether `REDDIT_CLIENT_ID` and
`REDDIT_CLIENT_SECRET` are set. Both emit the same `sourcePostId` (the Reddit
fullname, e.g. `t3_1abc234`) and the same source id, so switching adapters
later will not re-ingest history as new posts. There is a test pinning exactly
this. Hacker News and Google News feeds hedge the dependency further: if Reddit
disappears entirely, ingestion keeps running.

### Reddit rate limiting (measured, not assumed)

Reddit's `.rss` limiter is **per client across all feeds**, not per feed, and
budgets roughly one request per minute. Three back-to-back fetches of different
subreddits produced a 429 during M0 testing. Consequences:

- Reddit adapters retry with 8s/16s/32s backoff, not the 1s/2s/4s default.
- Every Reddit source declares `rateLimitBucket: 'reddit'` and queues behind a
  shared `MinIntervalGate` at one request per 60s (M1).
- Reddit sources poll at 600s, so five subreddits land near one Reddit request
  per 120s — inside budget with headroom for retries. `config/sources.json`
  enforces a floor, and a test pins it.

## Schema

`db/001_init.sql`. One deviation from the original spec worth flagging: the
spec had a single `signals` table carrying one ticker, but posts routinely
mention several tickers and dedupe keys on the *post*. So:

- **`posts`** — raw ingested content, `UNIQUE (source, source_post_id)`. This is
  what M1 dedupes against.
- **`signals`** — one row per (post × ticker), written by M2. A post mentioning
  NVDA and AMD produces two signals.
- **`baselines`**, **`watchlist`**, **`users`** — as specified.
- **`ingest_runs`** (M1, also not in the spec) — one row per fetch attempt, with
  counts and any error. Makes unattended runs observable, is the source of M9's
  posts/day metric, and will back last-run reporting on `/health`.

## Configuration

All secrets live in `.env`, which is gitignored. `.env.example` is committed
with every key present and blank. Currently tracking 5 subreddits, the Hacker
News front page, and three per-ticker Google News queries.

---

## Milestones

| # | Milestone | Acceptance | Status |
| --- | --- | --- | --- |
| **M0** | Verify + scaffold | Worker prints raw posts from one subreddit; `GET /health` returns 200 | ✅ done |
| **M1** | Ingestion pipeline | Two consecutive runs create no duplicate rows; a scheduled run fires unattended | ✅ done |
| **M2** | LLM sentiment scoring | Tests over hand-labeled sample posts confirm extraction is reasonable | ✅ code done, eval pending labels |
| **M3** | Spike detection | Tests prove the z-score formula flags a synthetic spike and ignores normal noise | next |
| **M4** | API + auth model | Demo role hitting an admin endpoint returns 403; the 61st request in a minute is throttled | |
| **M5** | Real-time push | A new signal appears live in two open browser tabs | |
| **M6** | Frontend dashboard | Live feed, per-ticker trends, watchlist; read-only demo login; end to end against local API | |
| **M7** | SMS alerting | A simulated spike on a watched ticker delivers a real SMS | |
| **M8** | Public deploy + abuse audit | Every public/demo endpoint re-checked to confirm none can trigger Gemini, Twilio, or an on-demand scrape; a stranger can load the dashboard with no login | |
| **M9** | Polish + measure | Product README with measured ingestion volume, scoring latency, detection accuracy, and push latency | |

## How ingestion runs

`npm run worker -- run` polls every source on its own interval, **serially**.
Nine sources at about a second each is nothing, and serial execution removes any
chance of two Reddit fetches overlapping.

- **Dedupe** is the database's job: a batched
  `INSERT ... ON CONFLICT (source, source_post_id) DO NOTHING RETURNING id`.
  No read-then-write, so re-running ingestion is a no-op and concurrent workers
  cannot race.
- **Pacing** is the `MinIntervalGate`'s job. Sources sharing a bucket queue
  behind each other; unrelated sources pass straight through.
- **Failure isolation**: one source throwing never stops the loop. It backs off
  exponentially (interval × 2^failures, capped at 1h) and returns to its normal
  cadence on the next success. At a 600s interval a dead feed settles at one
  retry per hour by its third failure.
- **Jitter** of ±10% keeps sources from converging into a thundering herd after
  a restart.
- **Shutdown**: SIGINT/SIGTERM finish the current fetch and exit. The
  scheduler's own sleeps are chunked at 500ms, and the rate-limit gate's wait
  takes the same abort signal — without that, a SIGTERM arriving during a 60s
  gate wait sat unanswered for the rest of the interval, long enough for a
  platform with a 30s kill grace to hard-kill the worker mid-fetch. A second
  signal exits immediately.

## Sentiment scoring (M2)

Scoring runs **on demand only** — never on a schedule. The Gemini free tier is a
fixed daily request quota rather than a bill, so consuming it should be a
deliberate act.

```bash
npm run worker -- score-once --dry-run   # what would be sent; calls nothing
npm run worker -- score-once --limit 60  # actually score
```

### Two halves, and only one of them costs quota

Ticker extraction is **not** the model's job. A regex plus an allowlist of real
listed symbols proposes candidates; the model only judges whether each candidate
is really a ticker mention in context and how the post feels about it.

A post with no candidate ticker is marked scored with zero signals and **never
reaches the model**. Measured on the first 575 real ingested posts:

| | |
|---|---:|
| Posts considered | 575 |
| Filtered out locally, zero quota | 258 (45%) |
| Sent to the model | 317 |
| Requests needed (batch size 15) | **22** |

The allowlist comes from the SEC's [`company_tickers.json`](https://www.sec.gov/files/company_tickers.json)
(committed to the repo, refresh with `node scripts/refresh-tickers.ts`). That
file contains **operating companies only, no ETFs**, so a short curated ETF list
is merged in — otherwise SPY, QQQ and IWM, three of the most-discussed symbols
on these subreddits, would be invisible to the extractor. A stoplist suppresses
real symbols that are ordinary words in context (`DD`, `IT`, `OPEN`, `A`) unless
written as an explicit cashtag.

### Staying inside the quota

Google no longer publishes per-model free-tier limits in its docs — they are
project-specific and visible only at
[aistudio.google.com/rate-limit](https://aistudio.google.com/rate-limit).
Read yours before changing anything below. Ours, measured 2026-09-04:

| Model | RPM | TPM | **RPD** |
|---|---:|---:|---:|
| `gemini-3.5-flash` | 5 | 250K | **20** |
| `gemini-3.5-flash-lite` | 15 | 250K | **500** |

Widely-cited third-party guides claimed ~1,500 RPD for Flash. The real figure
for this project is **20** — off by 75×. Do not size anything off a blog post.

That gap decides the model: Flash's 20 requests/day cannot clear even a single
22-request backlog, so scoring runs on **Flash Lite**. Sentiment classification
on short posts sits comfortably in Lite's range.

The guardrails, in the same order they fire:

- **Client-side throttle.** Gemini shares the `MinIntervalGate` built for
  Reddit, at one request per 4s — Flash Lite's 15 RPM ceiling exactly.
- **Hard local daily ceiling.** `GEMINI_DAILY_REQUEST_BUDGET` (400, under the
  real 500) is checked against `llm_requests` before every request, counted over
  the **Pacific** day because that is when Google's quota resets.
- **Provider 429s stop the run** rather than hammering a spent quota.

TPM is not a constraint at our size: a 15-post batch is roughly 4–5K tokens, so
even at the full 15 RPM we use about 70K of the 250K TPM allowance.

At ~500–1000 ingested posts/day, steady-state scoring is roughly 20–40 requests
per day — under 10% of the daily quota.

> **Two free-tier caveats worth knowing.** Enabling billing on the Google Cloud
> project **removes the free tier for that project entirely** — keep the key on a
> billing-off project. And on the free tier Google's terms permit using submitted
> prompts to improve their models; everything pulse sends is already-public
> Reddit/HN/news text, but the tradeoff is real.

### Validation is ours, not the provider's

Gemini's structured output honours only a **subset** of JSON Schema — notably it
does not enforce numeric `minimum`/`maximum`. So the API schema constrains shape
only, and every bound is re-checked locally with Zod. On top of the schema:

- **post_id alignment.** The set of ids returned must exactly match the set sent.
  Batching 15 posts invites the model to drop, duplicate or invent an entry, and
  a shuffled result would attach one post's sentiment to another post's row with
  nothing downstream able to notice.
- **Hallucinated tickers are dropped.** A symbol that was never offered as a
  candidate is discarded, not stored.
- **Batch failure degrades gracefully.** An invalid batch response is retried one
  post per request, so one bad entry cannot cost fourteen good posts.
- **Atomic writes.** Signals and `scored_at` commit in one transaction, so a
  crash can never mark a post scored with no signals.
- **Poison posts drop out.** Three failed attempts and a post leaves the queue.

## Cost

Nothing in pulse calls a paid API. Ingestion is public RSS; scoring is Gemini's
free tier.

| Service | Cost | From |
| --- | --- | --- |
| RSS sources (Reddit, HN, Google News) | free | M0 |
| Reddit OAuth, non-commercial | free ≤100 QPM | if approved |
| Gemini Flash | **$0** — free tier, no card. See the scoring section for how we stay inside the quota | M2 |
| Twilio | ~$1.15/mo number + ~$0.008/SMS | M7 |
| Hosting (Neon, Render, Vercel free tiers) | free | M8 |

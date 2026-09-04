# pulse

Detects unusual sentiment spikes for US equities by continuously ingesting
retail and news chatter, scoring it with Claude, and comparing each ticker
against its own rolling baseline.

> **Status: M0 complete.** Scaffold, schema, source abstraction, and a working
> ingestion read path. Nothing is persisted or scored yet — see the milestone
> plan below.

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
| Scoring | Claude (`claude-haiku-4-5`) with structured output |
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

Verify ingestion:

```bash
npm run worker -- list-sources
npm run worker -- fetch-once --source reddit:wallstreetbets --limit 5
```

Verify the API:

```bash
npm run dev:api
curl localhost:3000/health
# {"status":"ok","db":"up","redditAdapter":"reddit-rss","sources":9,...}
```

Tests and typecheck:

```bash
npm test
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
- `config/sources.json` enforces a 300s floor on Reddit `pollSeconds` (tested).
- **M1 must serialize Reddit fetches behind a single global token bucket.**
  Polling five subreddits concurrently every 5 minutes will get throttled.

## Schema

`db/001_init.sql`. One deviation from the original spec worth flagging: the
spec had a single `signals` table carrying one ticker, but posts routinely
mention several tickers and dedupe keys on the *post*. So:

- **`posts`** — raw ingested content, `UNIQUE (source, source_post_id)`. This is
  what M1 dedupes against.
- **`signals`** — one row per (post × ticker), written by M2. A post mentioning
  NVDA and AMD produces two signals.
- **`baselines`**, **`watchlist`**, **`users`** — as specified.

## Configuration

All secrets live in `.env`, which is gitignored. `.env.example` is committed
with every key present and blank. Currently tracking 5 subreddits, the Hacker
News front page, and three per-ticker Google News queries.

---

## Milestones

| # | Milestone | Acceptance | Status |
| --- | --- | --- | --- |
| **M0** | Verify + scaffold | Worker prints raw posts from one subreddit; `GET /health` returns 200 | ✅ done |
| **M1** | Ingestion pipeline | Two consecutive runs create no duplicate rows; a scheduled run fires unattended | next |
| **M2** | LLM sentiment scoring | Tests over hand-labeled sample posts confirm extraction is reasonable | |
| **M3** | Spike detection | Tests prove the z-score formula flags a synthetic spike and ignores normal noise | |
| **M4** | API + auth model | Demo role hitting an admin endpoint returns 403; the 61st request in a minute is throttled | |
| **M5** | Real-time push | A new signal appears live in two open browser tabs | |
| **M6** | Frontend dashboard | Live feed, per-ticker trends, watchlist; read-only demo login; end to end against local API | |
| **M7** | SMS alerting | A simulated spike on a watched ticker delivers a real SMS | |
| **M8** | Public deploy + abuse audit | Every public/demo endpoint re-checked to confirm none can trigger Claude, Twilio, or an on-demand scrape; a stranger can load the dashboard with no login | |
| **M9** | Polish + measure | Product README with measured ingestion volume, scoring latency, detection accuracy, and push latency | |

## Cost

Nothing in M0 or M1 calls a paid API.

| Service | Cost | From |
| --- | --- | --- |
| RSS sources (Reddit, HN, Google News) | free | M0 |
| Reddit OAuth, non-commercial | free ≤100 QPM | if approved |
| Claude `claude-haiku-4-5` | metered; cut hard by batching, prompt caching, and the Batch API | M2 |
| Twilio | ~$1.15/mo number + ~$0.008/SMS | M7 |
| Hosting (Neon, Render, Vercel free tiers) | free | M8 |

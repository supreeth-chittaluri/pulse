# Measurements

Every number here came from a real run, with the method stated so it can be
disputed or reproduced. Where a measurement turned out to be wrong, that is
recorded too — this file is the audit trail, not the highlight reel.

---

## Ingestion

| | |
|---|---|
| Sources polled | 9 — five subreddits, Hacker News, three per-ticker news queries |
| Poll interval | 600s (Reddit), 600s (HN), 900s (news) |
| **Sustained rate** | **50 posts/hour → ~1,200/day** while the service is awake |
| Posts stored, first sustained run | 575 in ~20 minutes of catch-up |
| Duplicate rate at steady state | **35.4%** of fetched posts already stored |

**Method (rate).** Two `/api/stats` samples 18.1 minutes apart against the live
deployment, pinging `/health` every two minutes throughout so the free tier could
not sleep mid-window. 602 → 617 posts.

**Method.** `ingest_runs` records every fetch attempt with counts. Over 16 runs:
890 posts fetched, 575 inserted, 0 errors.

**Reddit's rate limit is per client, not per feed.** Three back-to-back fetches
of *different* subreddits returned 429. That is why every Reddit adapter shares
one 60s bucket and the config floors Reddit polling at 600s. This was discovered
by hitting it, not by reading a doc — the published limits describe a per-feed
budget.

**Free-tier spin-down suppresses real volume.** A host that sleeps after 15
minutes of no traffic ingests nothing while asleep. Observed directly: a
measurement window failed because the service had gone to sleep mid-sample.
Continuous ingestion needs the keepalive workflow.

---

## Scoring

| | |
|---|---|
| Posts filtered before the model | **45%** (258 of 575) |
| Posts scored | 317 in **22 requests**, 15 per batch |
| Mean latency | **5.3s** per request · 386ms per post |
| Latency range | 1.7s – 8.2s |
| Tokens | 62,828 in / 41,549 out |
| Failures | 0 |
| Production batch | 60 posts → 30 filtered, 30 scored, 2 requests, 32 signals |

**Method.** `llm_requests` records every model call with token counts and
duration. Figures above are the aggregate over all successful requests.

**The 45% is the prefilter, and it is free.** A regex plus the SEC's listed-symbol
allowlist answers "is there even a ticker here" without spending a token. Of the
posts that *do* reach the model, some are further rejected as non-mentions — 57%
of all scored posts ultimately produced no signal.

**Quota context.** At the measured rate, steady-state scoring is roughly 20–40
requests/day against a 500/day free-tier allowance.

---

## Spike detection

Operating characteristics at the default threshold `z ≥ 3.0`, over **2,000
simulated series per cell**:

| Baseline rate | 1× (no spike) | 1.5× | 2× | 3× | 5× | 10× |
|---|---:|---:|---:|---:|---:|---:|
| 4/hr | **0.05%** | 4.7% | 22.2% | 69.6% | 98.7% | 100% |
| 10/hr | **0.20%** | 11.0% | 51.8% | 97.5% | 100% | 100% |
| 25/hr | **0.15%** | 32.2% | 91.0% | 99.9% | 100% | 100% |

The 1× column is the false-positive rate; the rest is detection rate at that
multiple of the baseline.

**Method.** Seeded RNG, Poisson-distributed hourly counts, normally-distributed
sentiment. Each trial builds 168 hours of history and one test window. Both the
false-positive ceiling and the detection floor are pinned by tests — a detector
that never fires also never false-positives, so asserting one side proves
nothing.

**The 2× row is the honest one.** A doubling at 4 mentions/hour is caught 22% of
the time. On a Poisson process, 4 → 8 genuinely is not distinguishable from
luck. Volume buys confidence, and no threshold choice escapes that.

**Why not the schema's default of 2.5?** At `z ≥ 2.5` across ~90 tickers checked
hourly, normally-distributed noise alone produces roughly one false alert per
hour — enough to make an SMS channel worthless. `watchlist.alert_threshold`
still overrides per ticker.

---

## Live updates

| | |
|---|---|
| SSE end-to-end, local | **108ms** median (105 / 108 / 111 over 6 probes) |
| SSE connect → first event, production | **148ms** (`open` at 91ms) |
| Polling fallback interval | 5s |
| Debounce | 100ms, deliberate — coalesces a 15-signal scoring burst into one flush |

**Method (local).** Six signals inserted directly into Postgres while holding an
SSE connection, timing insert → event receipt. The 108ms is dominated by the
100ms debounce; the transport itself is single-digit milliseconds.

**Method (production).** `EventSource` opened in a browser against the live URL,
recording event timings.

### A measurement error worth recording

I reported that the deployment buffered streamed responses and that SSE was
therefore undeliverable. **That was wrong**, and I built a polling fallback on
it before catching the mistake.

`curl` buffers its own stdout when that is a pipe rather than a terminal, and
`timeout` killed it before it flushed. A working stream read as **zero bytes**.
A response written in ten chunks 300ms apart read as **a single burst at the
end**. Both results were consistent with the buffering theory and both were
artifacts of the measuring tool.

A Node client and a browser each showed the truth on the first try: chunks
arrive progressively, exactly as written.

The lesson, applied since: **confirm a negative result with a second,
independent client before building on it.** `/api/stream/selftest` exists so the
check takes one request on any future host.

A closely related error, same shape: the first `LISTEN/NOTIFY` delivery probe
sent its `NOTIFY` on the connection it was listening on. A transaction-mode
pooler permits exactly that while never delivering a real cross-connection
trigger — so the probe reported healthy on precisely the configuration it was
written to catch. It now notifies from the application pool.

---

## HTTP

| | |
|---|---|
| Response cache | 20s TTL on anonymous GETs |
| Cache miss, DB-backed endpoint | 0.204 – 0.314s |
| No-DB endpoint | 0.145 – 0.247s |
| Attributable to the database round trip | **~60–80ms** |

**Method.** Cache-busting query strings to force misses, compared against an
endpoint that touches no database. Measured from a client roughly 3,000km from
the service.

**That ~60–80ms is a region mismatch**, not a query cost: the service was
deployed in Oregon against a database in `us-east-2`. Deployment region should
match the database region; Render's is immutable after creation.

---

## Test suite

| | |
|---|---|
| Tests | **262** across 20 files |
| Database-backed | Real throwaway Postgres, not mocks |
| Simulated trials in the detector suite | ~5,200 per run |

Database-backed tests use real Postgres because in several places the constraint
*is* the behaviour: mocking the unique index that prevents a duplicate SMS would
leave the guarantee untested.

# HTTP API

Three access tiers. **Anonymous** covers every read plus the globally bounded
manual scoring action. **Demo** is anonymous plus a signed-in UI state and
deliberately no extra data access. **Admin** covers watchlist mutations.

Base URL: the deployment root. The dashboard is served from the same origin, so
there is no CORS hop.

## Public

| | |
|---|---|
| `GET /health` | Liveness, plus the serving commit, stream transport, and whether the worker runs in-process |
| `GET /api/stats` | Totals: posts, signals, tickers, spikes, last ingest/signal timestamps |
| `GET /api/signals` | Recent signals. `?ticker=` `?sinceHours=` `?limit=` (max 200) |
| `GET /api/signals?afterId=` | Cursor read, oldest-first, for polling clients. Echoes the next cursor |
| `GET /api/spikes` | Recent detections with their z-scores and baselines |
| `GET /api/tickers` | Ranked by mentions, with average sentiment, baseline, and a 24h sparkline |
| `GET /api/tickers/:ticker` | Hourly trend series plus recent signals for one ticker |
| `GET /api/stream` | Server-Sent Events: `ready`, `signal`, `spike` |
| `GET /api/stream/status` | Live connection count and hub cursor |
| `GET /api/stream/selftest` | Bounded streaming diagnostic — ten chunks, 300ms apart, then ends |

Every `limit` is capped server-side. A public endpoint that honours an unbounded
limit is a free denial-of-service against its own database.

## Auth

| | |
|---|---|
| `POST /api/auth/login` | `{ email, password }` → `{ token, role, email }` |
| `GET /api/auth/me` | Who the bearer token belongs to |
| `POST /api/auth/logout` | Tokens are stateless and short-lived; the client discards |
| `POST /api/auth/signup` | **403** — public signup is disabled by design |

Login returns an identical response and burns comparable time for an unknown
account, so it cannot be used to enumerate email addresses.

## Admin

Bearer token with the `admin` role. Anonymous gets 401, demo gets 403.

| | |
|---|---|
| `GET /api/admin/watchlist` | Tickers being watched and their alert thresholds |
| `POST /api/admin/watchlist` | `{ tickerOrTopic, alertThreshold }` |
| `DELETE /api/admin/watchlist/:ticker` | Remove one |

## Manual scoring

Available to anonymous, demo, and admin visitors.

| | |
|---|---|
| `GET /api/scoring/status` | Local-triage and Gemini backlogs, failed posts, automatic schedule, request budget, and manual-run use |
| `POST /api/scoring/run` | **Spends Gemini quota.** Scores up to 60 queued posts |

The application normally scores up to 60 candidate posts every 30 minutes. The
manual trigger is an immediate catch-up option protected by a durable, app-wide
limit of ten accepted runs per Pacific quota day, a three-attempts-per-minute
client limiter, the 60-post run cap, and the same overlap lock as automatic
scoring. Every individual provider call—including validation retries—must first
reserve space under the shared 400-request daily ceiling. Once the manual limit
is used it returns `429 daily_score_limit_reached`; while either kind of run is
active it returns `409 scoring_in_progress`.

Signal objects expose `observedAt`, the source post's publication time (falling
back to ingestion time), so scoring an old backlog does not make old posts look
new.

## Response shapes worth calling out

`GET /api/tickers` returns a `series` on every row: 24 hourly mention counts,
oldest first, **zero-filled**. A gap in the data is a real quiet hour and has to
be drawn as one — dropping empty buckets would produce a line implying
continuous chatter. The series is computed in the same query as the summary, so
100 tickers is one round trip rather than 101.

`baselineAvgVolume` and `baselineAvgSentiment` are `null` until a ticker has
enough history for a baseline to exist. Clients should render that absence
rather than substituting zero: a missing baseline and a baseline of zero mean
opposite things.

## Live stream

```
event: ready
data: {"cursor":"128-4","backfilled":12}

event: signal
id: 129-4
data: {"id":129,"tickerOrTopic":"NVDA","sentimentScore":0.82,...}
```

The `id` line is a cursor pair — `signalId-spikeId` — because signals and spikes
have independent sequences and a single number cannot address a position in the
combined stream. `EventSource` returns it as `Last-Event-ID` on reconnect and
the server replays exactly what was missed.

Connections are bounded: 100 total, 3 per client. The request rate limiter
cannot help here, because one SSE connection is a single request that then lives
for hours.

## Rate limits

| Bucket | Limit |
|---|---|
| Public | 60 / minute per IP |
| Admin | 10 / minute per IP |
| Login | 10 / minute per IP |

The 61st public request in a minute returns 429 with `Retry-After`. The limiter
is in-process — it resets on restart and two instances would each allow the full
budget. Correct for one small instance; a shared store is needed to scale out.

## Errors

```json
{ "error": "forbidden", "message": "This endpoint requires the admin role." }
```

`401` means "we do not know who you are", `403` means "we do and you may not".
Validation failures return `400` with Zod issues attached. Server errors return
`{"error":"internal_error"}` and nothing else — a stack trace on a public
endpoint is an information leak.

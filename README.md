# pulse

**Finds the tickers people suddenly started talking about — and whether they're
happy about it.**

[![tests](https://img.shields.io/badge/tests-247%20passing-1a7f37)](#testing)
[![cost](https://img.shields.io/badge/running%20cost-%240-1a7f37)](#cost)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-2a78d6)](#stack)
[![Node](https://img.shields.io/badge/Node-24-2a78d6)](#stack)
[![Postgres](https://img.shields.io/badge/Postgres-17-2a78d6)](#stack)
[![license](https://img.shields.io/badge/license-MIT-898781)](LICENSE)

**[Live demo →](https://pulse-b8zd.onrender.com)**  ·  demo login
`demo@pulse.local` / `demo-read-only` (read-only)

> The demo runs on a free tier that sleeps after ~15 minutes without traffic, so
> the first load may take up to a minute to wake. **A sleeping service also
> ingests nothing** — observed directly while measuring, and the reason the
> repo ships a keepalive workflow.

<!-- TODO: replace with a recorded GIF of the live feed updating -->
<p align="center"><em>(demo GIF goes here)</em></p>

---

## The problem

Sentiment on a ticker is only interesting **relative to its own normal**.

r/stocks mentions AAPL constantly — that's background noise. r/stocks mentioning
a small-cap forty times in an hour when it normally gets two is a signal. Most
sentiment tools threshold on raw positivity and drown in the former.

pulse maintains a rolling baseline per ticker and flags statistical deviations
from it, gating on *how much* something is discussed before caring *how* it is
discussed. A sentiment swing measured over two mentions is noise; a volume surge
with flat sentiment is usually just a scheduled news cycle. The combination is
the thing worth an alert.

## What it does

- **Ingests** five subreddits, Hacker News and per-ticker Google News on a
  schedule, deduped so re-running changes nothing.
- **Extracts tickers without the LLM** — a regex plus the SEC's listed-symbol
  list proposes candidates, so ~45% of posts never reach the model at all.
- **Scores sentiment** with Gemini Flash Lite behind a hard validation layer:
  every numeric bound re-checked locally, hallucinated tickers dropped, and the
  returned post ids required to match the ones sent.
- **Detects spikes** with a rolling per-ticker z-score on both volume and
  sentiment, measured at a **0.05–0.20% false-positive rate**.
- **Pushes live** to the dashboard over SSE, with a polling fallback for hosts
  that buffer streamed responses.
- **Alerts by SMS** when a watchlisted ticker spikes, behind four independent
  spend brakes.
- **Serves a public dashboard** anyone can open with no login, with a read-only
  demo account and an admin role for anything that spends a resource.

## Measured

Real numbers from real runs, not estimates:

| | |
|---|---|
| Ingestion volume | **INGEST_RATE_PLACEHOLDER** |
| Posts filtered before the model | **45%** (258 of 575) — free, deterministic |
| Scoring throughput | 317 posts in **22 requests** (15 per batch) |
| Scoring latency | **5.3s** mean per request · 386ms per post · max 8.2s |
| Token cost | 62.8K in / 41.5K out for 317 posts |
| Spike false-positive rate | **0.05–0.20%** over 2,000 simulated series per cell |
| Spike detection at 5× volume | **98.7–100%** |
| Update latency (SSE, local) | **108ms** median, insert → browser |
| Live stream first event (production) | **148ms** from connect |
| Update latency (polling fallback) | 5s interval |
| Running cost | **$0** |

Spike detector operating characteristics, at the default `z ≥ 3.0`:

| Baseline rate | 1× (no spike) | 2× | 3× | 5× | 10× |
|---|---:|---:|---:|---:|---:|
| 4/hr | **0.05%** | 22.2% | 69.6% | 98.7% | 100% |
| 10/hr | **0.20%** | 51.8% | 97.5% | 100% | 100% |
| 25/hr | **0.15%** | 91.0% | 99.9% | 100% | 100% |

The 1× column is the false-positive rate. Both bounds are pinned by tests — a
detector that never fires also never false-positives, so asserting only one side
would prove nothing.

That 2× row is honest rather than flattering: a doubling at 4 mentions/hour is
caught 22% of the time. On a Poisson process 4→8 genuinely is not
distinguishable from luck. Volume buys confidence.

## Stack

| Layer | Choice |
|---|---|
| Language | TypeScript, npm workspaces monorepo |
| Runtime | Node 24 — native type stripping, no build step server-side |
| Database | Postgres 17 |
| Ingestion | RSS/Atom + Reddit OAuth behind one `Source` interface |
| Scoring | Gemini `gemini-3.5-flash-lite`, structured output + Zod validation |
| API | Express 5 |
| Dashboard | React 19 + Vite, no state library, served by the API |
| Live updates | SSE with a cursor-based polling fallback |
| Alerting | Twilio REST |
| Tests | Vitest — 247, against real Postgres where the constraint *is* the logic |
| Deploy | Neon + a single Render web service |

## Running it

```bash
cp .env.example .env      # defaults work for local development
npm install
npm run db:up             # Postgres 17 in Docker, host port 5433
npm run db:migrate
npm run db:seed
```

```bash
npm run worker -- run     # ingest + detect spikes, on a schedule
```

```bash
npm run build:web && npm run start:api    # dashboard on :3000
```

Scoring is **on demand**, because it spends a finite daily quota:

```bash
npm run worker -- score-once --dry-run    # what it would send, and how much
npm run worker -- score-once --limit 60
```

Full command list: `npm run worker -- --help`.

## Testing

```bash
npm test          # needs `npm run db:up`; DB-backed tests skip loudly without it
npm run typecheck
```

Database-backed tests run against a real throwaway Postgres rather than mocks,
because in several places the constraint *is* the behaviour under test —
mocking the unique index that prevents duplicate SMS would leave the guarantee
untested.

The abuse audit is a test rather than a checklist, since checklists get read
once and then rot:

```bash
npx vitest run apps/api/src/abuse-audit.test.ts
```

It proves no anonymous or demo route can reach Gemini, Twilio, or an on-demand
scrape — behaviourally (with `fetch` stubbed, on a *fully configured* instance)
and structurally (the module graph from public routes never reaches the paid
providers).

## Cost

**$0.** Ingestion is public RSS; scoring runs inside Gemini's free tier at
roughly 20–40 requests/day against a 500/day allowance; hosting is Neon and
Render free tiers. Twilio is the only component that would cost money and it
stays off unless explicitly enabled.

## Documentation

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — how it works and why, including the
  decisions that were measured rather than assumed
- **[DEPLOY.md](DEPLOY.md)** — deploying to free tiers, and the limitations
  that come with them

## Status

Built in nine milestones, M0 through M9. Two things are deliberately incomplete:

- **SMS alerting is verified to the provider boundary**, not through it. A
  Twilio number is a recurring cost and this project otherwise runs at $0.
  Message composition, retry policy, masked storage, the duplicate-send
  constraint and all four spend brakes are tested against a fake notifier;
  what is unexercised is one authenticated form POST.
- **The scoring eval awaits hand labels.** `eval/labels.jsonl` holds 25
  stratified posts and 48 ticker judgements. The model's own predictions are
  excluded from that file on purpose — labels anchored on them would mostly
  measure agreement with itself.

## License

MIT

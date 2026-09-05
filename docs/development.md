# Running it locally

Node 22+ and Docker. No other prerequisites — TypeScript runs directly via
Node's native type stripping, so there is no server-side build step.

```bash
cp .env.example .env      # defaults work as-is for local development
npm install
npm run db:up             # Postgres 17 in Docker, host port 5433
npm run db:migrate
npm run db:seed           # creates the demo and admin accounts
```

## The three processes

**Worker** — ingestion on a schedule, plus spike detection every 5 minutes:

```bash
npm run worker -- run
```

**API + dashboard** — one origin, no CORS:

```bash
npm run build:web && npm run start:api    # http://localhost:3000
```

**Frontend with hot reload**, proxying `/api` to port 3000:

```bash
npm run dev:web
```

## Scoring is on demand

Scoring spends a finite daily quota, so it never runs on a timer:

```bash
npm run worker -- score-once --dry-run    # what would be sent, and how much
npm run worker -- score-once --limit 60
```

`--dry-run` needs no API key. A full pass takes about four minutes: five Reddit
sources at one request per minute through the shared rate-limit gate. That is
the limiter working, not a hang.

## Every command

```
list-sources                Show every configured source and its adapter
fetch-once --source <id>    Fetch one source and print it (writes nothing)
ingest-once                 Fetch every source once and write to Postgres
run                         Poll every source on its schedule until stopped
status                      Stored counts and the last run per source
score-once                  Score pending posts with Gemini
detect-spikes               Recompute baselines and flag spikes (free)
alerts                      Send SMS for pending spikes (costs money)
```

## Tests

```bash
npm test          # needs `npm run db:up`; DB-backed tests skip loudly without it
npm run typecheck
```

Database-backed tests create and drop their own throwaway databases. They use
real Postgres rather than mocks because in several places the constraint *is*
the behaviour under test.

The abuse audit is worth running on its own after any route change:

```bash
npx vitest run apps/api/src/abuse-audit.test.ts
```

## Refreshing reference data

```bash
npm run tickers:refresh    # regenerate config/tickers.json from the SEC
```

The SEC requires a genuine contact address in `USER_AGENT`; set it in `.env`
before running this.

## Configuration

Everything is environment-driven and documented inline in `.env.example`,
including which milestone each setting belongs to and which ones cost money.
Nothing secret is ever committed — `.env` is git-ignored and `.env.example`
ships with every value blank.

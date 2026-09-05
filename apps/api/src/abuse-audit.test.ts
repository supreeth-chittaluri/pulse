import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPool, makeTestConfig, upsertUser, type Logger, type Pool } from '@pulse/core';
import { runMigrations } from '../../../db/migrate.ts';
import { createApp, type PulseApp } from './app.ts';
import { hashPassword } from './auth/password.ts';

/**
 * M8's abuse audit, as a test rather than a checklist.
 *
 * Exactly one public endpoint may trigger Gemini: the manual Score now action.
 * It is constrained to ten durable global runs per day and 60 posts per run.
 * Every other public/demo endpoint must remain unable to reach Gemini, Twilio,
 * or an on-demand scrape.
 *
 * A checklist gets re-read once and then rots. This runs on every commit.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
try {
  process.loadEnvFile(resolve(repoRoot, '.env'));
} catch {
  /* docker-compose defaults below */
}

const baseUrl = process.env.DATABASE_URL ?? 'postgres://pulse:pulse@localhost:5433/pulse';
const TEST_DATABASE = 'pulse_audit_test';

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

let pool: Pool | undefined;
let skipReason: string | null = null;

try {
  const admin = createPool(withDatabase(baseUrl, 'postgres'));
  try {
    await admin.query(`drop database if exists ${TEST_DATABASE} with (force)`);
    await admin.query(`create database ${TEST_DATABASE}`);
  } finally {
    await admin.end();
  }
  pool = createPool(withDatabase(baseUrl, TEST_DATABASE));
  await runMigrations(pool, { dir: resolve(repoRoot, 'db'), quiet: true });
} catch (err) {
  skipReason = (err as Error).message;
  console.warn(`\n  SKIPPING abuse audit -- Postgres unreachable: ${skipReason}\n`);
}

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

type Tier = 'anonymous' | 'bounded' | 'admin';

/**
 * Every route the application exposes, with the access tier it must enforce.
 *
 * Maintained by hand on purpose: the count is cross-checked against the router
 * below, so adding a route without classifying it here fails the audit rather
 * than silently shipping unclassified.
 */
const ROUTES: Array<{ method: string; path: string; tier: Tier; body?: unknown }> = [
  { method: 'GET', path: '/health', tier: 'anonymous' },
  { method: 'GET', path: '/stream', tier: 'anonymous' },

  { method: 'GET', path: '/api/stats', tier: 'anonymous' },
  { method: 'GET', path: '/api/signals', tier: 'anonymous' },
  { method: 'GET', path: '/api/spikes', tier: 'anonymous' },
  { method: 'GET', path: '/api/tickers', tier: 'anonymous' },
  { method: 'GET', path: '/api/tickers/NVDA', tier: 'anonymous' },
  { method: 'GET', path: '/api/stream/status', tier: 'anonymous' },
  // Bounded (~3s) and touches no database, but it is public, so the audit
  // still has to prove it cannot reach a paid provider.
  { method: 'GET', path: '/api/stream/selftest', tier: 'anonymous' },
  { method: 'GET', path: '/api/scoring/status', tier: 'anonymous' },
  { method: 'POST', path: '/api/scoring/run', tier: 'bounded' },

  { method: 'POST', path: '/api/auth/login', tier: 'anonymous', body: { email: 'a@b.co', password: 'x' } },
  { method: 'GET', path: '/api/auth/me', tier: 'anonymous' },
  { method: 'POST', path: '/api/auth/logout', tier: 'anonymous' },
  { method: 'POST', path: '/api/auth/signup', tier: 'anonymous', body: { email: 'a@b.co', password: 'xxxxxxxx' } },

  { method: 'GET', path: '/api/admin/watchlist', tier: 'admin' },
  { method: 'POST', path: '/api/admin/watchlist', tier: 'admin', body: { tickerOrTopic: 'NVDA' } },
  { method: 'DELETE', path: '/api/admin/watchlist/NVDA', tier: 'admin' },
];

/**
 * The SSE stream route is exercised separately: it holds a socket open, so
 * driving it like a normal request would hang this suite.
 */
const STREAM_ROUTE = { method: 'GET', path: '/api/stream' };

let app: PulseApp;
let server: Server;
let origin: string;

const DEMO_PASSWORD = 'demo-password';
const ADMIN_PASSWORD = 'admin-password-long';

/**
 * Requests go over node:http, not fetch, so that a stubbed global fetch
 * measures only what the SERVER called -- which is the whole point.
 */
function call(
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, reject) => {
    const url = new URL(origin + path);
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const headers: Record<string, string> = {};
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(payload));
    }

    const req = httpRequest(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers, agent: false },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function login(email: string, password: string): Promise<string> {
  const result = await call('POST', '/api/auth/login', { body: { email, password } });
  return (JSON.parse(result.body) as { token: string }).token;
}

beforeAll(async () => {
  if (skipReason !== null) return;
  app = createApp({
    config: makeTestConfig({
      databaseUrl: withDatabase(baseUrl, TEST_DATABASE),
      // Credentials present on purpose: the audit must prove the guards hold
      // even on a fully-configured instance, not merely that an unconfigured
      // one cannot spend.
      gemini: {
        apiKey: 'test-key-should-never-be-used',
        model: 'gemini-3.5-flash-lite',
        minIntervalMs: 0,
        dailyRequestBudget: 400,
      },
      alerts: {
        enabled: true,
        configured: true,
        twilio: { accountSid: 'AC0', authToken: 'tok', from: '+1555', to: '+1555' },
        kind: 'volume+sentiment',
        cooldownHours: 6,
        dailyBudget: 10,
        maxSpikeAgeHours: 6,
      },
    }),
    pool: pool!,
    logger: silentLogger,
  });
  server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  await upsertUser(pool!, 'demo@pulse.local', 'demo', await hashPassword(DEMO_PASSWORD));
  await upsertUser(pool!, 'admin@pulse.local', 'admin', await hashPassword(ADMIN_PASSWORD));
});

afterAll(async () => {
  server?.close();
  await pool?.end();
});

beforeEach(async () => {
  app?.resetState();
  await pool?.query('truncate score_runs restart identity');
});

describe.skipIf(skipReason !== null)('route inventory', () => {
  // Drift detector. A route added without being classified above fails here
  // rather than shipping unaudited.
  it('classifies every route the router actually exposes', () => {
    function walk(stack: any[]): number {
      let count = 0;
      for (const layer of stack) {
        if (layer.route) count += Object.keys(layer.route.methods).length;
        else if (layer.handle?.stack) count += walk(layer.handle.stack);
      }
      return count;
    }
    const exposed = walk((app as unknown as { router: { stack: unknown[] } }).router.stack);

    // +1 for the SSE stream route, audited separately because it holds a socket.
    // +1 for POST /api/auth/login, which is registered twice (once to attach the
    // stricter login rate limiter, once by the auth router).
    // +1 for POST /api/scoring/run, likewise registered once for its dedicated
    // short-window limiter and once inside the scoring router.
    expect(ROUTES.length + 3).toBe(exposed);
  });
});

describe.skipIf(skipReason !== null)('ordinary anonymous and demo routes cannot spend money', () => {
  /**
   * Gemini and Twilio are both reached over global fetch, and so is every
   * ingestion source. Stubbing it and asserting zero calls therefore covers all
   * three of M8's named hazards at once, without having to know which client
   * library is in play.
   */
  async function assertNoOutboundCalls(token: string | undefined, label: string) {
    const spy = vi.spyOn(globalThis, 'fetch');
    try {
      for (const route of ROUTES) {
        if (route.tier !== 'anonymous') continue;
        await call(route.method, route.path, { token, body: route.body });
      }
      expect(spy.mock.calls.map((c) => String(c[0])), `${label} triggered an outbound request`)
        .toEqual([]);
    } finally {
      spy.mockRestore();
    }
  }

  it('makes no outbound request for an anonymous visitor', async () => {
    await assertNoOutboundCalls(undefined, 'anonymous');
  });

  it('makes no outbound request for the demo role', async () => {
    const token = await login('demo@pulse.local', DEMO_PASSWORD);
    await assertNoOutboundCalls(token, 'demo');
  });

  it('makes no outbound request when a stranger opens the live stream', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    try {
      const url = new URL(origin + STREAM_ROUTE.path);
      const req = httpRequest(
        { hostname: url.hostname, port: url.port, path: url.pathname, agent: false },
        (res) => res.resume(),
      );
      req.on('error', () => {});
      req.end();
      await new Promise((r) => setTimeout(r, 300));
      req.destroy();

      expect(spy.mock.calls).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe.skipIf(skipReason !== null)('admin-only mutations remain protected', () => {
  const adminRoutes = ROUTES.filter((r) => r.tier === 'admin');

  it('rejects every admin route without a token', async () => {
    for (const route of adminRoutes) {
      const result = await call(route.method, route.path, { body: route.body });
      expect(result.status, `${route.method} ${route.path}`).toBe(401);
    }
  });

  it('rejects every admin route for the demo role', async () => {
    const token = await login('demo@pulse.local', DEMO_PASSWORD);
    for (const route of adminRoutes) {
      const result = await call(route.method, route.path, { token, body: route.body });
      expect(result.status, `${route.method} ${route.path}`).toBe(403);
    }
  });

});

describe.skipIf(skipReason !== null)('public scoring has durable spending bounds', () => {
  it('cannot reach Gemini after the global daily limit is used', async () => {
    await pool!.query('insert into score_runs (completed_at) select now() from generate_series(1, 10)');
    const spy = vi.spyOn(globalThis, 'fetch');
    try {
      const result = await call('POST', '/api/scoring/run');
      expect(result.status).toBe(429);
      expect(JSON.parse(result.body).error).toBe('daily_score_limit_reached');
      expect(spy.mock.calls).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('cannot launch a second Gemini job while one is running', async () => {
    await pool!.query('insert into score_runs default values');
    const spy = vi.spyOn(globalThis, 'fetch');
    try {
      expect((await call('POST', '/api/scoring/run')).status).toBe(409);
      expect(spy.mock.calls).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('public route modules cannot reach a paid provider', () => {
  /**
   * A structural guarantee on top of the behavioural one.
   *
   * The behavioural test proves today's handlers do not spend. This proves they
   * *could not*: the module graph reachable from the anonymous routes never
   * reaches the Gemini or Twilio clients, so a future edit that wires one in
   * fails here immediately rather than at the first surprise invoice.
   */
  const FORBIDDEN = ['@pulse/scoring', '@pulse/alerting'];
  const apiSrc = resolve(repoRoot, 'apps/api/src');

  function importsOf(file: string): string[] {
    const source = readFileSync(file, 'utf8');
    return [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
  }

  function reachable(entry: string, seen = new Set<string>()): Set<string> {
    if (seen.has(entry)) return seen;
    seen.add(entry);
    for (const specifier of importsOf(entry)) {
      if (specifier.startsWith('.')) {
        reachable(resolve(dirname(entry), specifier), seen);
      } else {
        seen.add(specifier);
      }
    }
    return seen;
  }

  for (const entry of ['routes/public.ts', 'routes/auth.ts', 'routes/stream.ts']) {
    it(`${entry} never reaches a paid provider`, () => {
      const graph = reachable(resolve(apiSrc, entry));
      for (const forbidden of FORBIDDEN) {
        expect([...graph], `${entry} can reach ${forbidden}`).not.toContain(forbidden);
      }
    });
  }

  it('only the explicitly bounded scoring route reaches Gemini', () => {
    const entry = resolve(apiSrc, 'routes/scoring.ts');
    const graph = reachable(entry);
    const source = readFileSync(entry, 'utf8');
    expect([...graph]).toContain('@pulse/scoring');
    expect(source).toContain('DAILY_SCORE_RUN_LIMIT = 10');
    expect(source).toContain('SCORE_POST_LIMIT = 60');
    expect(source).toContain('reserveScoreRun');

    expect([...reachable(resolve(apiSrc, 'routes/admin.ts'))]).not.toContain('@pulse/scoring');
  });
});

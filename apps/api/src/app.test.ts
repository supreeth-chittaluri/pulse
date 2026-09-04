import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createPool,
  makeTestConfig,
  upsertUser,
  type Config,
  type Logger,
  type Pool,
} from '@pulse/core';
import { runMigrations } from '../../../db/migrate.ts';
import { createApp, type PulseApp } from './app.ts';
import { hashPassword } from './auth/password.ts';
import { PRIVATE_DEMO_MESSAGE } from './routes/auth.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
try {
  process.loadEnvFile(resolve(repoRoot, '.env'));
} catch {
  /* docker-compose defaults below */
}

const baseUrl = process.env.DATABASE_URL ?? 'postgres://pulse:pulse@localhost:5433/pulse';
const TEST_DATABASE = 'pulse_api_test';

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
  console.warn(`\n  SKIPPING API tests -- Postgres unreachable: ${skipReason}\n`);
}

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const DEMO_PASSWORD = 'demo-password';
const ADMIN_PASSWORD = 'admin-password-long';

let app: PulseApp;
let server: Server;
let origin: string;
let config: Config;

/** Every mutating route under /api/admin, as the acceptance test enumerates them. */
const ADMIN_ROUTES: Array<{ method: string; path: string; body?: unknown }> = [
  { method: 'GET', path: '/api/admin/watchlist' },
  { method: 'GET', path: '/api/admin/scoring-status' },
  { method: 'POST', path: '/api/admin/watchlist', body: { tickerOrTopic: 'NVDA' } },
  { method: 'DELETE', path: '/api/admin/watchlist/NVDA' },
  { method: 'POST', path: '/api/admin/score', body: { limit: 1 } },
];

async function call(
  path: string,
  options: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: any; headers: Headers }> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  const response = await fetch(`${origin}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* non-JSON body */
  }
  return { status: response.status, body: parsed, headers: response.headers };
}

async function login(email: string, password: string): Promise<string> {
  const { body, status } = await call('/api/auth/login', {
    method: 'POST',
    body: { email, password },
  });
  if (status !== 200) throw new Error(`login failed: ${JSON.stringify(body)}`);
  return body.token as string;
}

beforeAll(async () => {
  if (skipReason) return;
  config = makeTestConfig({ databaseUrl: withDatabase(baseUrl, TEST_DATABASE) });
  app = createApp({ config, pool: pool!, logger: silentLogger });
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

beforeEach(() => {
  app?.resetState();
});

describe.skipIf(skipReason !== null)('anonymous access', () => {
  // M8's acceptance criterion, asserted here rather than discovered at deploy.
  it('serves every read endpoint with no token at all', async () => {
    for (const path of ['/health', '/api/stats', '/api/signals', '/api/spikes', '/api/tickers']) {
      const { status } = await call(path);
      expect(status, path).toBe(200);
    }
  });

  it('caps limit server-side', async () => {
    expect((await call('/api/signals?limit=99999')).status).toBe(400);
    expect((await call('/api/signals?limit=200')).status).toBe(200);
  });

  it('rejects a malformed ticker', async () => {
    expect((await call('/api/signals?ticker=NOTATICKER')).status).toBe(400);
    expect((await call('/api/tickers/toolong')).status).toBe(400);
  });

  it('404s an unknown route without leaking anything', async () => {
    const { status, body } = await call('/api/nope');
    expect(status).toBe(404);
    expect(body).toEqual({ error: 'not_found' });
  });
});

describe.skipIf(skipReason !== null)('authentication', () => {
  it('issues a token for correct credentials', async () => {
    const { status, body } = await call('/api/auth/login', {
      method: 'POST',
      body: { email: 'demo@pulse.local', password: DEMO_PASSWORD },
    });
    expect(status).toBe(200);
    expect(body.role).toBe('demo');
    expect(typeof body.token).toBe('string');
  });

  it('is case-insensitive about the email', async () => {
    const { status } = await call('/api/auth/login', {
      method: 'POST',
      body: { email: 'DEMO@PULSE.LOCAL', password: DEMO_PASSWORD },
    });
    expect(status).toBe(200);
  });

  it('rejects a wrong password', async () => {
    const { status, body } = await call('/api/auth/login', {
      method: 'POST',
      body: { email: 'demo@pulse.local', password: 'wrong' },
    });
    expect(status).toBe(401);
    expect(body.error).toBe('invalid_credentials');
  });

  // Identical response for both, so login cannot be used to discover which
  // email addresses have accounts.
  it('does not reveal whether an account exists', async () => {
    const unknown = await call('/api/auth/login', {
      method: 'POST',
      body: { email: 'nobody@pulse.local', password: 'wrong' },
    });
    const known = await call('/api/auth/login', {
      method: 'POST',
      body: { email: 'demo@pulse.local', password: 'wrong' },
    });
    expect(unknown.status).toBe(known.status);
    expect(unknown.body).toEqual(known.body);
  });

  it('reports the caller via /me', async () => {
    const token = await login('admin@pulse.local', ADMIN_PASSWORD);
    const { status, body } = await call('/api/auth/me', { token });
    expect(status).toBe(200);
    expect(body).toMatchObject({ authenticated: true, role: 'admin' });
  });

  it('rejects garbage, tampered, and foreign-signed tokens', async () => {
    const token = await login('demo@pulse.local', DEMO_PASSWORD);
    const tampered = `${token.slice(0, -3)}xyz`;

    for (const candidate of ['garbage', tampered, '', 'a.b.c']) {
      const { status } = await call('/api/auth/me', { token: candidate });
      expect(status, candidate).toBe(401);
    }
  });

  it('disables signup with the private-demo message', async () => {
    const { status, body } = await call('/api/auth/signup', {
      method: 'POST',
      body: { email: 'x@y.com', password: 'whatever' },
    });
    expect(status).toBe(403);
    expect(body.message).toBe(PRIVATE_DEMO_MESSAGE);
  });
});

describe.skipIf(skipReason !== null)('authorization', () => {
  // The M4 acceptance criterion.
  it('returns 403 for a demo token on every admin route', async () => {
    const token = await login('demo@pulse.local', DEMO_PASSWORD);

    for (const route of ADMIN_ROUTES) {
      const { status, body } = await call(route.path, {
        method: route.method,
        token,
        body: route.body,
      });
      expect(status, `${route.method} ${route.path}`).toBe(403);
      expect(body.error).toBe('forbidden');
    }
  });

  // 401 vs 403 is not cosmetic: one means "who are you", the other "not you".
  it('returns 401 for no token on every admin route', async () => {
    for (const route of ADMIN_ROUTES) {
      const { status } = await call(route.path, { method: route.method, body: route.body });
      expect(status, `${route.method} ${route.path}`).toBe(401);
    }
  });

  it('allows an admin token through', async () => {
    const token = await login('admin@pulse.local', ADMIN_PASSWORD);
    const { status, body } = await call('/api/admin/watchlist', { token });
    expect(status).toBe(200);
    expect(body.watchlist).toEqual([]);
  });

  it('lets admin manage the watchlist end to end', async () => {
    const token = await login('admin@pulse.local', ADMIN_PASSWORD);

    expect(
      (await call('/api/admin/watchlist', {
        method: 'POST',
        token,
        body: { tickerOrTopic: 'nvda', alertThreshold: 4 },
      })).status,
    ).toBe(201);

    const listed = await call('/api/admin/watchlist', { token });
    expect(listed.body.watchlist).toEqual([
      expect.objectContaining({ tickerOrTopic: 'NVDA', alertThreshold: 4 }),
    ]);

    expect((await call('/api/admin/watchlist/NVDA', { method: 'DELETE', token })).status).toBe(200);
    expect((await call('/api/admin/watchlist/NVDA', { method: 'DELETE', token })).status).toBe(404);
  });

  // Guards M8: a route added to adminRoutes later inherits the mount-level
  // guard, and this proves the mount is what enforces it.
  it('rejects an unknown path under /api/admin before routing it', async () => {
    const demoToken = await login('demo@pulse.local', DEMO_PASSWORD);
    expect((await call('/api/admin/anything-new', { token: demoToken })).status).toBe(403);
    expect((await call('/api/admin/anything-new')).status).toBe(401);
  });
});

describe.skipIf(skipReason !== null)('rate limiting', () => {
  // The M4 acceptance criterion: the 61st request in a minute is throttled.
  it('throttles the 61st request in a minute', async () => {
    for (let i = 1; i <= 60; i += 1) {
      const { status } = await call('/api/stats');
      expect(status, `request ${i}`).toBe(200);
    }

    const { status, body, headers } = await call('/api/stats');
    expect(status).toBe(429);
    expect(body.error).toBe('rate_limited');
    expect(Number(headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('reports the remaining budget', async () => {
    const first = await call('/api/stats');
    expect(first.headers.get('x-ratelimit-limit')).toBe('60');
    expect(first.headers.get('x-ratelimit-remaining')).toBe('59');
  });

  it('keeps admin routes on a separate, tighter budget', async () => {
    const token = await login('admin@pulse.local', ADMIN_PASSWORD);
    for (let i = 1; i <= 10; i += 1) {
      expect((await call('/api/admin/watchlist', { token })).status, `request ${i}`).toBe(200);
    }
    expect((await call('/api/admin/watchlist', { token })).status).toBe(429);

    // The public budget is untouched by admin traffic.
    expect((await call('/api/stats')).status).toBe(200);
  });

  it('throttles login attempts harder than ordinary reads', async () => {
    for (let i = 1; i <= 10; i += 1) {
      await call('/api/auth/login', {
        method: 'POST',
        body: { email: 'demo@pulse.local', password: 'wrong' },
      });
    }
    const { status } = await call('/api/auth/login', {
      method: 'POST',
      body: { email: 'demo@pulse.local', password: DEMO_PASSWORD },
    });
    expect(status).toBe(429);
  });
});

describe.skipIf(skipReason !== null)('response cache', () => {
  it('serves a repeat anonymous read from cache', async () => {
    const first = await call('/api/stats');
    const second = await call('/api/stats');
    expect(first.headers.get('x-cache')).toBe('MISS');
    expect(second.headers.get('x-cache')).toBe('HIT');
    expect(second.body).toEqual(first.body);
  });

  // A cached response served to the wrong person is the classic cache bug.
  it('never serves a cached body to an authenticated request', async () => {
    const token = await login('demo@pulse.local', DEMO_PASSWORD);
    await call('/api/stats');
    const authenticated = await call('/api/stats', { token });
    expect(authenticated.headers.get('x-cache')).toBeNull();
  });

  it('keys the cache by full URL including query', async () => {
    await call('/api/signals?limit=5');
    const other = await call('/api/signals?limit=6');
    expect(other.headers.get('x-cache')).toBe('MISS');
  });
});

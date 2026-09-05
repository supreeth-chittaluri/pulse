import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { request as httpRequest, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPool, insertPosts, makeTestConfig, type Logger, type Pool } from '@pulse/core';
import { runMigrations } from '../../../../db/migrate.ts';
import { createApp, type PulseApp } from '../app.ts';
import { StreamHub, formatCursor, parseCursor } from './hub.ts';
import { createChangeListener, probeNotifyDelivery, type ProbeConnection } from './listener.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
try {
  process.loadEnvFile(resolve(repoRoot, '.env'));
} catch {
  /* docker-compose defaults below */
}

const baseUrl = process.env.DATABASE_URL ?? 'postgres://pulse:pulse@localhost:5433/pulse';
const TEST_DATABASE = 'pulse_stream_test';

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

const testDbUrl = withDatabase(baseUrl, TEST_DATABASE);

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
  pool = createPool(testDbUrl);
  await runMigrations(pool, { dir: resolve(repoRoot, 'db'), quiet: true });
} catch (err) {
  skipReason = (err as Error).message;
  console.warn(`\n  SKIPPING stream tests -- Postgres unreachable: ${skipReason}\n`);
}

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

let app: PulseApp;
let server: Server;
let origin: string;
let hub: StreamHub;

/**
 * Subscriptions are torn down after every test. A leaked subscriber would make
 * later assertions about subscriberCount meaningless -- and the leak itself is
 * one of the bugs this suite exists to catch.
 */
const openSubscriptions: Array<() => void> = [];
function subscribe(fn: (event: unknown) => void): () => void {
  const off = hub.subscribe(fn);
  openSubscriptions.push(off);
  return off;
}

/** Inserts one post + one signal, which the database trigger publishes. */
async function insertSignal(ticker = 'NVDA', sentiment = 0.5): Promise<number> {
  const { insertedIds } = await insertPosts(pool!, [
    {
      source: 'reddit:test',
      sourcePostId: `t3_${Math.random().toString(36).slice(2)}`,
      title: `${ticker} is moving`,
      body: null,
      url: 'https://example.com',
      author: 'someone',
      postedAt: new Date(),
    },
  ]);
  const { rows } = await pool!.query<{ id: string }>(
    `insert into signals (post_id, source, ticker_or_topic, sentiment_score, confidence, raw_excerpt)
     values ($1, 'reddit:test', $2, $3, 0.9, 'x') returning id`,
    [insertedIds[0], ticker, sentiment],
  );
  return Number(rows[0]!.id);
}

/**
 * Every SSE connection in this suite goes over a raw socket, never fetch.
 *
 * Both reasons were found the hard way here:
 *   - fetch tears down a response whose body is never consumed, so a connection
 *     opened only to be counted dies on its own after about a second;
 *   - fetch pools sockets per origin, so aborting a request whose body was not
 *     fully read leaves the socket in that pool. The server still counts the
 *     connection as live, and the next test's assertions are wrong.
 *
 * These tests assert the server's own connection accounting, so a client with
 * one socket per connection and an explicit destroy is the honest tool.
 */
type RawStream = {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  close: () => void;
};

function openRaw(
  headers: Record<string, string> = {},
  onChunk?: (chunk: string) => void,
): Promise<RawStream> {
  const url = new URL(`${origin}/api/stream`);
  return new Promise((resolvePromise, reject) => {
    const request = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'GET',
        agent: false, // no keep-alive pool: one socket, ours to destroy
        headers,
      },
      (response) => {
        response.setEncoding('utf8');
        if (onChunk) response.on('data', onChunk);
        else response.resume();
        resolvePromise({
          statusCode: response.statusCode ?? 0,
          headers: response.headers,
          // Destroy the socket itself, not just the request handle. In-process
          // (client and server on one event loop) destroying only the request
          // does not deliver a FIN the server notices, so its connection
          // accounting never sees the disconnect.
          close: () => {
            response.destroy();
            request.destroy();
            request.socket?.destroy();
          },
        });
      },
    );
    request.on('error', () => {
      /* expected when close() destroys the socket */
    });
    request.end();
    setTimeout(() => reject(new Error('stream did not open')), 3000).unref?.();
  });
}

async function openStream(): Promise<{ close: () => void }> {
  const stream = await openRaw();
  expect(stream.statusCode).toBe(200);
  return { close: stream.close };
}

type CollectedEvent = { name: string; id: string; data: any };

/** Opens a stream and resolves once `want` events arrive, or on timeout. */
async function collectEvents(
  want: number,
  options: { lastEventId?: string; timeoutMs?: number } = {},
): Promise<{ events: CollectedEvent[]; close: () => void }> {
  const events: CollectedEvent[] = [];
  let buffer = '';
  let settle: (() => void) | undefined;
  const arrived = new Promise<void>((r) => {
    settle = r;
  });

  const stream = await openRaw(
    options.lastEventId ? { 'last-event-id': options.lastEventId } : {},
    (chunk) => {
      buffer += chunk;
      let split: number;
      while ((split = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const name = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        const id = /^id: (.+)$/m.exec(block)?.[1] ?? '';
        if (name && name !== 'ready' && data) events.push({ name, id, data: JSON.parse(data) });
      }
      if (events.length >= want) settle?.();
    },
  );

  expect(stream.statusCode).toBe(200);
  expect(stream.headers['content-type']).toContain('text/event-stream');

  await Promise.race([
    arrived,
    new Promise<void>((r) => setTimeout(r, options.timeoutMs ?? 5000).unref?.()),
  ]);

  return { events, close: stream.close };
}

beforeAll(async () => {
  if (skipReason) return;
  hub = new StreamHub({ pool: pool!, logger: silentLogger, debounceMs: 20 });
  await hub.initialize();
  app = createApp({
    config: makeTestConfig({ databaseUrl: testDbUrl }),
    pool: pool!,
    logger: silentLogger,
    hub,
    // Short heartbeat so the server writes often. A server only discovers a
    // dead peer when it next writes or the OS reports the close; in-process
    // the write is what reliably surfaces it.
    streamOptions: { heartbeatMs: 100 },
  });
  server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  while (openSubscriptions.length > 0) openSubscriptions.pop()!();
});

afterAll(async () => {
  hub?.close();
  server?.close();
  await pool?.end();
});

beforeEach(async () => {
  app?.resetState();
  if (pool) {
    await pool.query('truncate posts, signals, spikes restart identity cascade');
    await hub.initialize();
  }
});

describe.skipIf(skipReason !== null)('StreamHub', () => {
  it('delivers a new signal to a subscriber', async () => {
    const received: unknown[] = [];
    subscribe((event) => received.push(event));

    await insertSignal();
    await hub.flush();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ name: 'signal' });
  });

  // The M5 acceptance criterion at the hub level: two clients, one event.
  it('delivers the same event to two independent subscribers', async () => {
    const a: unknown[] = [];
    const b: unknown[] = [];
    subscribe((e) => a.push(e));
    subscribe((e) => b.push(e));

    await insertSignal();
    await hub.flush();

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]).toEqual(b[0]);
  });

  it('does not replay rows that existed before it started', async () => {
    await insertSignal();
    await hub.initialize();

    const received: unknown[] = [];
    subscribe((e) => received.push(e));
    await hub.flush();

    expect(received).toHaveLength(0);
  });

  it('advances its cursor so a row is delivered once only', async () => {
    const received: unknown[] = [];
    subscribe((e) => received.push(e));

    await insertSignal();
    await hub.flush();
    await hub.flush();
    await hub.flush();

    expect(received).toHaveLength(1);
  });

  it('coalesces a burst into one flush', async () => {
    const received: unknown[] = [];
    subscribe((e) => received.push(e));

    // Scoring writes ~15 signals at once; many wakes must collapse into one read.
    for (let i = 0; i < 15; i += 1) await insertSignal(`T${i % 5}`);
    hub.wake();
    hub.wake();
    hub.wake();
    await new Promise((r) => setTimeout(r, 120));

    expect(received).toHaveLength(15);
  });

  it('unsubscribes cleanly', async () => {
    const received: unknown[] = [];
    const off = subscribe((e) => received.push(e));
    off();

    await insertSignal();
    await hub.flush();

    expect(received).toHaveLength(0);
    expect(hub.subscriberCount).toBe(0);
  });

  it('keeps delivering to other subscribers when one throws', async () => {
    const good: unknown[] = [];
    subscribe(() => {
      throw new Error('client blew up');
    });
    subscribe((e) => good.push(e));

    await insertSignal();
    await hub.flush();

    expect(good).toHaveLength(1);
  });

  it('backfills from a cursor', async () => {
    const first = await insertSignal('AAA');
    await insertSignal('BBB');
    await insertSignal('CCC');

    const events = await hub.backfill({ signalId: first, spikeId: 0 }, 50);

    expect(events).toHaveLength(2);
    expect(events.map((e) => (e.payload as any).tickerOrTopic)).toEqual(['BBB', 'CCC']);
  });
});

describe('cursor encoding', () => {
  it('round-trips', () => {
    expect(parseCursor(formatCursor({ signalId: 12, spikeId: 3 }))).toEqual({
      signalId: 12,
      spikeId: 3,
    });
  });

  it('rejects malformed values rather than guessing', () => {
    for (const raw of ['', 'abc', '1', '1-', '-1', '1-2-3', 'x-y', '1e5-2']) {
      expect(parseCursor(raw), raw).toBeNull();
    }
    expect(parseCursor(undefined)).toBeNull();
  });
});

describe.skipIf(skipReason !== null)('SSE endpoint', () => {
  it('streams a signal to a live HTTP connection', async () => {
    const pending = collectEvents(1);
    await new Promise((r) => setTimeout(r, 150));

    await insertSignal('TSLA', -0.4);
    await hub.flush();

    const { events, close } = await pending;
    close();

    expect(events).toHaveLength(1);
    expect(events[0]!.name).toBe('signal');
    expect(events[0]!.data.tickerOrTopic).toBe('TSLA');
    expect(events[0]!.id).toMatch(/^\d+-\d+$/);
  });

  // "Open two browser tabs, trigger a new signal, watch it appear in both."
  it('delivers one signal to two concurrent connections', async () => {
    const first = collectEvents(1);
    const second = collectEvents(1);
    await new Promise((r) => setTimeout(r, 200));

    await insertSignal('NVDA', 0.8);
    await hub.flush();

    const [a, b] = await Promise.all([first, second]);
    a.close();
    b.close();

    expect(a.events).toHaveLength(1);
    expect(b.events).toHaveLength(1);
    expect(a.events[0]!.data.id).toBe(b.events[0]!.data.id);
  });

  it('replays what a reconnecting client missed via Last-Event-ID', async () => {
    const first = await insertSignal('AAA');
    await insertSignal('BBB');
    await insertSignal('CCC');

    const { events, close } = await collectEvents(2, {
      lastEventId: formatCursor({ signalId: first, spikeId: 0 }),
    });
    close();

    // Exactly the missed rows: no gap, and no duplicate of the one already seen.
    expect(events.map((e) => e.data.tickerOrTopic)).toEqual(['BBB', 'CCC']);
  });

  it('ignores a malformed Last-Event-ID instead of erroring', async () => {
    const stream = await openRaw({ 'last-event-id': 'not-a-cursor' });
    expect(stream.statusCode).toBe(200);
    stream.close();
  });

  // A buffering proxy holds a response until its buffer fills, so a stream
  // that emits a few hundred bytes an hour reaches the client as nothing at
  // all. Observed in production behind Cloudflare: 40s, zero bytes, not even a
  // heartbeat.
  it('sends padding up front so a buffering proxy flushes', async () => {
    let firstChunk = '';
    const stream = await openRaw({}, (chunk) => {
      if (!firstChunk) firstChunk = chunk;
    });
    await new Promise((r) => setTimeout(r, 200));
    stream.close();

    expect(firstChunk.startsWith(':')).toBe(true);
    expect(firstChunk.length).toBeGreaterThan(2048);
  });

  it('reports how much history it replayed, so empty is distinguishable from broken', async () => {
    await insertSignal('AAA');
    let buffer = '';
    const stream = await openRaw({}, (chunk) => (buffer += chunk));
    await new Promise((r) => setTimeout(r, 300));
    stream.close();

    const ready = /^event: ready\ndata: (.+)$/m.exec(buffer);
    expect(ready).not.toBeNull();
    expect((JSON.parse(ready![1]!) as { backfilled: number }).backfilled).toBeGreaterThanOrEqual(0);
  });

  it('sets headers that keep proxies from buffering or caching it', async () => {
    const stream = await openRaw();
    expect(stream.headers['cache-control']).toContain('no-cache');
    expect(stream.headers['x-accel-buffering']).toBe('no');
    stream.close();
  });

  // Connection accounting (caps, slot release, leak-free release) is covered
  // deterministically in connections.test.ts. Asserting it over live sockets
  // made this suite unreliable: whether a disconnect is observed depends on the
  // HTTP client and its pooling, and with client and server sharing one process
  // under the test runner, socket closes are not delivered dependably. Verified
  // correct against a real out-of-process client.
  //
  // What is still worth asserting here is that the route actually consults the
  // registry and turns a refusal into the right HTTP response. Its own server
  // with a cap of one keeps that independent of anything other tests left open.
  it('turns a registry refusal into 429 on the wire', async () => {
    const scopedApp = createApp({
      config: makeTestConfig({ databaseUrl: testDbUrl }),
      pool: pool!,
      logger: silentLogger,
      hub,
      streamOptions: { maxConnectionsPerIp: 1 },
    });
    const scopedServer = scopedApp.listen(0);
    await new Promise<void>((r) => scopedServer.once('listening', r));
    const scopedOrigin = `http://127.0.0.1:${(scopedServer.address() as AddressInfo).port}`;

    const held = await new Promise<{ close: () => void }>((resolvePromise) => {
      const req = httpRequest(
        { hostname: '127.0.0.1', port: new URL(scopedOrigin).port, path: '/api/stream', agent: false },
        (response) => {
          response.resume();
          resolvePromise({ close: () => req.destroy() });
        },
      );
      req.on('error', () => {});
      req.end();
    });

    try {
      const rejected = await fetch(`${scopedOrigin}/api/stream`, {
        signal: AbortSignal.timeout(2000),
      });
      expect(rejected.status).toBe(429);
      expect(((await rejected.json()) as { error: string }).error).toBe('too_many_streams');
    } finally {
      held.close();
      scopedServer.close();
    }
  });
});

/**
 * The delivery probe, tested against fake connections rather than a real
 * socket. Racing a live database against a short timeout is not a test, it is a
 * coin flip -- and the behaviour worth pinning here is the decision, not the
 * timing.
 */
describe('probeNotifyDelivery', () => {
  type Listener = (message: { channel: string; payload?: string }) => void;

  /** A connection that echoes its own pg_notify back, like real Postgres. */
  function deliveringConnection(): ProbeConnection {
    const listeners = new Set<Listener>();
    return {
      on: (_event, listener) => listeners.add(listener),
      removeListener: (_event, listener) => listeners.delete(listener),
      query: async (_text, values) => {
        const [channel, payload] = values as [string, string];
        queueMicrotask(() => {
          for (const listener of listeners) listener({ channel, payload });
        });
        return undefined;
      },
    };
  }

  /**
   * A connection that accepts the NOTIFY and never delivers it. This is exactly
   * what a transaction-mode pooler does, and it is why the probe exists.
   */
  function silentConnection(): ProbeConnection {
    return {
      on: () => undefined,
      removeListener: () => undefined,
      query: async () => undefined,
    };
  }

  it('passes when the notification comes back', async () => {
    expect(await probeNotifyDelivery(deliveringConnection(), 1000)).toBe(true);
  });

  it('fails when LISTEN is accepted but nothing is delivered', async () => {
    expect(await probeNotifyDelivery(silentConnection(), 50)).toBe(false);
  });

  it('fails when the NOTIFY statement itself is rejected', async () => {
    const rejecting: ProbeConnection = {
      on: () => undefined,
      removeListener: () => undefined,
      query: async () => {
        throw new Error('permission denied for function pg_notify');
      },
    };
    expect(await probeNotifyDelivery(rejecting, 1000)).toBe(false);
  });

  it('ignores a notification that is not its own probe', async () => {
    const listeners = new Set<Listener>();
    const noisy: ProbeConnection = {
      on: (_event, listener) => listeners.add(listener),
      removeListener: (_event, listener) => listeners.delete(listener),
      query: async () => {
        // Unrelated traffic on another channel must not be mistaken for proof.
        queueMicrotask(() => {
          for (const listener of listeners) listener({ channel: 'pulse_signal', payload: '42' });
        });
        return undefined;
      },
    };
    expect(await probeNotifyDelivery(noisy, 50)).toBe(false);
  });
});

describe.skipIf(skipReason !== null)('change listener', () => {
  it('uses LISTEN/NOTIFY when the connection supports it', async () => {
    const onChange = vi.fn();
    const listener = await createChangeListener({
      databaseUrl: testDbUrl,
      logger: silentLogger,
      onChange,
    });

    expect(listener.kind).toBe('notify');
    await insertSignal();
    await new Promise((r) => setTimeout(r, 300));
    expect(onChange).toHaveBeenCalled();

    await listener.stop();
  });

  // Neon's pooled connection string does not support LISTEN/NOTIFY, and that is
  // exactly the URL a free-tier deploy is handed. Degrading to polling beats a
  // stream that silently never fires.
  it('falls back to polling when LISTEN is unavailable', async () => {
    const onChange = vi.fn();
    const listener = await createChangeListener({
      databaseUrl: testDbUrl,
      logger: silentLogger,
      onChange,
      pollIntervalMs: 50,
      disableNotify: true,
    });

    expect(listener.kind).toBe('poll');
    await new Promise((r) => setTimeout(r, 200));
    expect(onChange).toHaveBeenCalled();

    await listener.stop();
  });

  it('falls back rather than throwing when the database is unreachable', async () => {
    const listener = await createChangeListener({
      databaseUrl: 'postgres://nobody:nobody@127.0.0.1:1/nothing',
      logger: silentLogger,
      onChange: () => {},
      pollIntervalMs: 1000,
    });

    expect(listener.kind).toBe('poll');
    await listener.stop();
  });
});

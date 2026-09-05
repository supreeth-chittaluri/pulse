import { Router, type Request, type Response } from 'express';
import type { Logger } from '@pulse/core';
import { formatCursor, parseCursor, type StreamHub, type StreamEvent } from '../stream/hub.ts';
import { ConnectionRegistry } from '../stream/connections.ts';

export type StreamOptions = {
  hub: StreamHub;
  logger: Logger;
  /** Total concurrent streams this process will hold. */
  maxConnections?: number;
  maxConnectionsPerIp?: number;
  /**
   * Proxies commonly kill idle connections at 30-60s, and some will not flush
   * a response until they have seen traffic.
   */
  heartbeatMs?: number;
  /**
   * Bytes of comment padding sent before anything else. Some reverse proxies
   * (Cloudflare in front of Render, nginx with default buffering) hold a
   * response until their buffer fills, which makes a low-volume stream look
   * completely dead. 0 disables it.
   */
  paddingBytes?: number;
  /** Events replayed to a reconnecting client. */
  backfillLimit?: number;
};

function write(res: Response, chunk: string): void {
  res.write(chunk);
}

function sendEvent(res: Response, event: StreamEvent): void {
  // The id line is what the browser echoes back as Last-Event-ID on reconnect.
  write(
    res,
    `id: ${formatCursor(event.cursor)}\nevent: ${event.name}\ndata: ${JSON.stringify(event.payload)}\n\n`,
  );
}

/**
 * Server-Sent Events.
 *
 * SSE rather than WebSocket because the traffic is one-directional, it is plain
 * HTTP (so proxies and free-tier hosts do not have to be talked into an
 * upgrade), EventSource reconnects on its own, and it needs no dependency.
 */
export function streamRoutes(options: StreamOptions): Router {
  const {
    hub,
    logger,
    maxConnections = 100,
    maxConnectionsPerIp = 3,
    heartbeatMs = 15_000,
    paddingBytes = 4096,
    backfillLimit = 50,
  } = options;

  const router = Router();
  const registry = new ConnectionRegistry({ maxConnections, maxConnectionsPerIp });

  router.get('/', async (req: Request, res: Response) => {
    const ip = req.ip ?? 'unknown';

    const admitted = registry.acquire(ip);
    if (!admitted.ok) {
      res.status(admitted.status).json({
        error: admitted.reason,
        message:
          admitted.reason === 'too_many_streams'
            ? `At most ${maxConnectionsPerIp} live connections per client.`
            : 'Too many live connections.',
      });
      return;
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // nginx and similar buffer responses by default, which would hold events
    // until the buffer filled -- fatal for a stream.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const resume = parseCursor(req.get('last-event-id') ?? undefined);

    // Comment padding, sent first. A buffering proxy will not forward anything
    // until its buffer fills, and a stream that emits a few hundred bytes an
    // hour never reaches that threshold -- so the client sees nothing at all
    // and the connection looks broken rather than idle. EventSource ignores
    // comment lines, so this costs one flush and nothing else.
    if (paddingBytes > 0) write(res, `:${' '.repeat(paddingBytes)}\n\n`);
    write(res, `retry: 3000\n\n`);

    // Replay what this client missed while disconnected. Without it a dropped
    // connection leaves a permanent hole in the feed.
    let backfilledCount = 0;
    try {
      const missed = await hub.backfill(resume ?? hub.cursor, backfillLimit);
      for (const event of missed) sendEvent(res, event);
      backfilledCount = missed.length;
    } catch (err) {
      backfilledCount = -1;
      logger.error('stream backfill failed', { error: (err as Error).message });
    }

    write(
      res,
      `event: ready\ndata: ${JSON.stringify({
        cursor: formatCursor(hub.cursor),
        // Surfaced so a client (or a curl) can tell "no history" apart from
        // "backfill failed", which look identical otherwise.
        backfilled: backfilledCount,
      })}\n\n`,
    );

    const unsubscribe = hub.subscribe((event) => sendEvent(res, event));

    // Comment lines are ignored by EventSource but keep intermediaries from
    // treating the connection as idle and closing it.
    const heartbeat = setInterval(() => write(res, `: ping\n\n`), heartbeatMs);
    heartbeat.unref?.();

    let cleanedUp = false;
    const cleanup = (): void => {
      if (cleanedUp) return;
      cleanedUp = true;
      clearInterval(heartbeat);
      unsubscribe();
      registry.release(ip);
    };

    // Both, because which one fires depends on how the socket died. Leaking a
    // subscriber here is the classic SSE memory bug.
    req.on('close', cleanup);
    res.on('close', cleanup);

    logger.debug('stream connected', { ip, total: registry.total });
  });

  /**
   * Bounded streaming self-test.
   *
   * Distinguishes "the proxy in front of this app buffers streamed responses"
   * from "the stream is broken", which look identical from a client: both give
   * you nothing. Writes ten timestamped chunks 300ms apart and ends, so a
   * caller can see whether bytes arrive progressively or all at once at the
   * end. Public, read-only, bounded, and touches no database.
   */
  router.get('/selftest', async (_req, res) => {
    res.status(200);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const started = Date.now();
    for (let i = 0; i < 10; i += 1) {
      res.write(`chunk ${i} at +${Date.now() - started}ms ${'.'.repeat(900)}\n`);
      await new Promise((r) => setTimeout(r, 300));
    }
    res.end(`done at +${Date.now() - started}ms\n`);
  });

  router.get('/status', (_req, res) => {
    res.json({
      connections: registry.total,
      subscribers: hub.subscriberCount,
      cursor: formatCursor(hub.cursor),
      maxConnections,
      maxConnectionsPerIp,
    });
  });

  return router;
}

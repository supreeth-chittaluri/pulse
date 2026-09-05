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
  /** Proxies commonly kill idle connections at 30-60s. */
  heartbeatMs?: number;
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
    heartbeatMs = 25_000,
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
    write(res, `retry: 3000\n\n`);

    // Replay what this client missed while disconnected. Without it a dropped
    // connection leaves a permanent hole in the feed.
    try {
      const missed = await hub.backfill(resume ?? hub.cursor, backfillLimit);
      for (const event of missed) sendEvent(res, event);
    } catch (err) {
      logger.error('stream backfill failed', { error: (err as Error).message });
    }

    write(res, `event: ready\ndata: ${JSON.stringify({ cursor: formatCursor(hub.cursor) })}\n\n`);

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

import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Short-window response cache for anonymous reads.
 *
 * At our data rate a 20s window is invisible to a user but removes almost all
 * repeat database load, which matters once M5 has many browsers connected at
 * once. Only successful GETs are cached, and only for requests with no
 * Authorization header -- a per-user response must never be served to someone
 * else, and that is the kind of bug a cache introduces quietly.
 */
export type CacheOptions = {
  ttlSeconds: number;
  maxEntries?: number;
  now?: () => number;
};

type Entry = { expiresAt: number; body: string; contentType: string };

export type ResponseCache = RequestHandler & { reset(): void; size(): number };

export function responseCache(options: CacheOptions): ResponseCache {
  const { ttlSeconds, maxEntries = 500, now = Date.now } = options;
  const entries = new Map<string, Entry>();

  const middleware = (req: Request, res: Response, next: NextFunction): void => {
    if (ttlSeconds <= 0 || req.method !== 'GET' || req.get('authorization')) {
      next();
      return;
    }

    const key = req.originalUrl;
    const hit = entries.get(key);
    if (hit && hit.expiresAt > now()) {
      res.setHeader('Content-Type', hit.contentType);
      res.setHeader('X-Cache', 'HIT');
      res.setHeader('Cache-Control', `public, max-age=${ttlSeconds}`);
      res.status(200).send(hit.body);
      return;
    }
    if (hit) entries.delete(key);

    res.setHeader('X-Cache', 'MISS');

    const originalJson = res.json.bind(res);
    res.json = (body: unknown) => {
      if (res.statusCode === 200) {
        // Evict oldest-inserted first; Map preserves insertion order.
        if (entries.size >= maxEntries) {
          const oldest = entries.keys().next().value;
          if (oldest !== undefined) entries.delete(oldest);
        }
        entries.set(key, {
          expiresAt: now() + ttlSeconds * 1000,
          body: JSON.stringify(body),
          contentType: 'application/json; charset=utf-8',
        });
        res.setHeader('Cache-Control', `public, max-age=${ttlSeconds}`);
      }
      return originalJson(body);
    };

    next();
  };

  return Object.assign(middleware, {
    reset(): void {
      entries.clear();
    },
    size(): number {
      return entries.size;
    },
  });
}

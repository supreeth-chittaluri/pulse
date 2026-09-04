import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Sliding-window rate limiter held in process memory.
 *
 * Deliberately not Redis-backed: the free tiers this deploys to have no Redis,
 * and a Postgres-backed counter would mean a write on every request. The
 * tradeoff is real and worth stating plainly -- the window resets when the
 * process restarts, and two instances would each allow the full budget. That is
 * correct for a single small instance and would need a shared store the moment
 * this scales horizontally.
 */
export type RateLimitOptions = {
  /** Requests allowed per window. */
  limit: number;
  windowMs?: number;
  /** Distinguishes independent buckets, e.g. 'public' vs 'admin'. */
  bucket?: string;
  /** Injected in tests. */
  now?: () => number;
};

/** Keys with no recent hits are dropped so the map cannot grow without bound. */
const SWEEP_EVERY = 500;

export type RateLimiter = RequestHandler & { reset(): void };

export function rateLimit(options: RateLimitOptions): RateLimiter {
  const { limit, windowMs = 60_000, bucket = 'default', now = Date.now } = options;
  const hits = new Map<string, number[]>();
  let sinceSweep = 0;

  const middleware = (req: Request, res: Response, next: NextFunction): void => {
    const at = now();
    const windowStart = at - windowMs;
    // req.ip is only trustworthy when Express is told about the proxy; see
    // TRUST_PROXY in config. Without it every request shares one bucket.
    const key = `${bucket}:${req.ip ?? 'unknown'}`;

    const timestamps = (hits.get(key) ?? []).filter((t) => t > windowStart);

    if (timestamps.length >= limit) {
      const retryAfterMs = timestamps[0]! + windowMs - at;
      const retryAfter = Math.max(1, Math.ceil(retryAfterMs / 1000));
      hits.set(key, timestamps);
      res.setHeader('Retry-After', String(retryAfter));
      res.setHeader('X-RateLimit-Limit', String(limit));
      res.setHeader('X-RateLimit-Remaining', '0');
      res.status(429).json({
        error: 'rate_limited',
        message: `Too many requests. Retry in ${retryAfter}s.`,
        retryAfter,
      });
      return;
    }

    timestamps.push(at);
    hits.set(key, timestamps);
    res.setHeader('X-RateLimit-Limit', String(limit));
    res.setHeader('X-RateLimit-Remaining', String(limit - timestamps.length));

    sinceSweep += 1;
    if (sinceSweep >= SWEEP_EVERY) {
      sinceSweep = 0;
      for (const [existing, times] of hits) {
        if (times.every((t) => t <= windowStart)) hits.delete(existing);
      }
    }

    next();
  };

  return Object.assign(middleware, {
    reset(): void {
      hits.clear();
      sinceSweep = 0;
    },
  });
}

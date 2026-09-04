import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { Config, Logger, Pool } from '@pulse/core';
import { buildSources } from '@pulse/sources';
import { attachUser, requireRole } from './middleware/auth.ts';
import { rateLimit, type RateLimiter } from './middleware/rate-limit.ts';
import { responseCache, type ResponseCache } from './middleware/cache.ts';
import { publicRoutes } from './routes/public.ts';
import { authRoutes } from './routes/auth.ts';
import { adminRoutes } from './routes/admin.ts';

export type AppDeps = { config: Config; pool: Pool; logger: Logger };

export type PulseApp = Express & {
  /** Exposed so tests can clear limiter and cache state between cases. */
  resetState(): void;
};

/**
 * Three access tiers, and the boundary sits in exactly one place:
 *
 *   anonymous  every read. M8 requires a stranger to load the dashboard with
 *              no login, so these take no token at all.
 *   demo       identical reads plus a signed-in UI state. Deliberately grants
 *              no extra data access; it exists for the M6 narrative.
 *   admin      writes, and anything that spends a finite resource.
 */
export function createApp({ config, pool, logger }: AppDeps): PulseApp {
  const app = express() as PulseApp;
  app.disable('x-powered-by');

  // Without this, req.ip behind Render/Fly/Vercel is the proxy's address, every
  // request shares one rate-limit bucket, and the first client to reach the
  // limit locks out everybody.
  if (config.http.trustProxy > 0) app.set('trust proxy', config.http.trustProxy);

  app.use(express.json({ limit: '100kb' }));

  if (config.http.corsOrigins.length > 0) {
    app.use((req, res, next) => {
      const origin = req.get('origin');
      if (origin && config.http.corsOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      }
      if (req.method === 'OPTIONS') {
        res.sendStatus(204);
        return;
      }
      next();
    });
  }

  const publicLimiter: RateLimiter = rateLimit({
    limit: config.http.rateLimitPerMinute,
    bucket: 'public',
  });
  const adminLimiter: RateLimiter = rateLimit({
    limit: config.http.adminRateLimitPerMinute,
    bucket: 'admin',
  });
  // Brute-force protection on the only endpoint that checks a password.
  const loginLimiter: RateLimiter = rateLimit({ limit: 10, bucket: 'login' });
  const cache: ResponseCache = responseCache({ ttlSeconds: config.http.cacheTtlSeconds });

  app.use(attachUser(config.auth.jwtSecret));

  app.get('/health', async (_req, res) => {
    let db: 'up' | 'down' = 'down';
    try {
      await pool.query('select 1');
      db = 'up';
    } catch (err) {
      logger.error('health check: database unreachable', { error: (err as Error).message });
    }

    res.status(db === 'up' ? 200 : 503).json({
      status: db === 'up' ? 'ok' : 'degraded',
      db,
      redditAdapter: config.redditOAuthEnabled ? 'reddit-oauth' : 'reddit-rss',
      scoringModel: config.gemini.model,
      sources: buildSources(config).length,
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  app.post('/api/auth/login', loginLimiter);
  app.use('/api/auth', publicLimiter, authRoutes(pool, config, logger));

  app.use('/api', publicLimiter, cache, publicRoutes(pool));

  // requireRole sits on the mount, so it cannot be forgotten on an individual
  // route added to adminRoutes later. A test asserts every method/path under
  // /api/admin rejects a demo token.
  app.use(
    '/api/admin',
    adminLimiter,
    requireRole('admin'),
    adminRoutes(pool, config, logger),
  );

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    // Log the detail, return none: stack traces and driver messages are an
    // information leak on a public endpoint.
    logger.error('unhandled error', { path: req.path, error: err.message, stack: err.stack });
    if (res.headersSent) return;
    res.status(500).json({ error: 'internal_error' });
  });

  app.resetState = () => {
    publicLimiter.reset();
    adminLimiter.reset();
    loginLimiter.reset();
    cache.reset();
  };

  return app;
}

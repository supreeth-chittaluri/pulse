import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { Config, Logger, Pool } from '@pulse/core';
import { buildSources } from '@pulse/sources';
import { attachUser, requireRole } from './middleware/auth.ts';
import { rateLimit, type RateLimiter } from './middleware/rate-limit.ts';
import { responseCache, type ResponseCache } from './middleware/cache.ts';
import { publicRoutes } from './routes/public.ts';
import { authRoutes } from './routes/auth.ts';
import { adminRoutes } from './routes/admin.ts';
import { streamRoutes, type StreamOptions } from './routes/stream.ts';
import { StreamHub } from './stream/hub.ts';

export type AppDeps = {
  config: Config;
  pool: Pool;
  logger: Logger;
  /** Started by the caller; created unstarted here when omitted. */
  hub?: StreamHub;
  /** Overrides for the SSE endpoint. Tests shorten the heartbeat. */
  streamOptions?: Partial<Omit<StreamOptions, 'hub' | 'logger'>>;
  /**
   * Which change source the stream ended up on. Surfaced on /health because a
   * pooled Postgres URL silently downgrades LISTEN/NOTIFY to polling, and that
   * is otherwise invisible from outside the process.
   */
  streamSource?: 'notify' | 'poll';
};

export type PulseApp = Express & {
  /** Exposed so tests can clear limiter and cache state between cases. */
  resetState(): void;
  streamHub: StreamHub;
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
export function createApp({
  config,
  pool,
  logger,
  hub,
  streamOptions,
  streamSource,
}: AppDeps): PulseApp {
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
      streamSource: streamSource ?? 'unknown',
      workerInProcess: config.runWorkerInApi,
      sources: buildSources(config).length,
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  app.post('/api/auth/login', loginLimiter);
  app.use('/api/auth', publicLimiter, authRoutes(pool, config, logger));

  // Mounted before the /api limiter and cache: an SSE connection is one
  // request that lives for hours, so a per-request rate limit is meaningless
  // here and caching a stream would be actively wrong. It enforces a
  // concurrency cap of its own instead.
  const streamHub = hub ?? new StreamHub({ pool, logger });
  app.use('/api/stream', streamRoutes({ hub: streamHub, logger, ...streamOptions }));

  // Throwaway demo page proving M5's acceptance ("open two tabs"), superseded
  // by M6's dashboard.
  app.get('/stream', (_req, res) => {
    res.sendFile(fileURLToPath(new URL('../public/stream.html', import.meta.url)));
  });

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

  // Serve the built dashboard from this same origin.
  //
  // One origin means no CORS to configure, no cross-site cookie rules, and an
  // SSE connection that is same-origin by construction -- which is why the
  // dashboard is served here rather than deployed separately. Mounted after
  // every API route so it can never shadow one.
  const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url));
  if (existsSync(webDist)) {
    // Asset filenames are content-hashed by the bundler, so they are safe to
    // cache hard; index.html must not be, or a deploy would not reach anyone.
    app.use(express.static(webDist, { index: false, maxAge: '1h' }));

    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api') || req.path === '/health') {
        next();
        return;
      }
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(join(webDist, 'index.html'));
    });
  } else {
    logger.warn('dashboard build not found; run `npm run build:web`', { webDist });
  }

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

  app.streamHub = streamHub;
  app.resetState = () => {
    publicLimiter.reset();
    adminLimiter.reset();
    loginLimiter.reset();
    cache.reset();
  };

  return app;
}

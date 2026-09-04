import express, { type Express } from 'express';
import type { Config, Logger, Pool } from '@pulse/core';
import { buildSources } from '@pulse/sources';

export type AppDeps = { config: Config; pool: Pool; logger: Logger };

/**
 * Built separately from the listener so tests (and M4's auth tests) can drive
 * the app without binding a port.
 */
export function createApp({ config, pool, logger }: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  app.get('/health', async (_req, res) => {
    let db: 'up' | 'down' = 'down';
    try {
      await pool.query('select 1');
      db = 'up';
    } catch (err) {
      logger.error('health check: database unreachable', { error: (err as Error).message });
    }

    // Surfacing the adapter here is deliberate: after M8 is deployed, /health
    // tells us at a glance whether Reddit ingestion is on RSS or OAuth.
    const redditAdapter = config.redditOAuthEnabled ? 'reddit-oauth' : 'reddit-rss';

    res.status(db === 'up' ? 200 : 503).json({
      status: db === 'up' ? 'ok' : 'degraded',
      db,
      redditAdapter,
      sources: buildSources(config).length,
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  return app;
}

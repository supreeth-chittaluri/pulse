import { Router } from 'express';
import { z } from 'zod';
import {
  deleteWatchlistEntry,
  selectWatchlist,
  upsertWatchlistEntry,
  type Logger,
  type Pool,
} from '@pulse/core';

/**
 * Admin-only watchlist mutations.
 *
 * A router test asserts every route in this file sits behind
 * requireRole('admin'). Public scoring lives in its own tightly bounded router;
 * the watchlist remains an administrator-owned mutation.
 */
const watchlistSchema = z.object({
  tickerOrTopic: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{1,5}$/, 'ticker must be 1-5 letters'),
  alertThreshold: z.coerce.number().min(0.5).max(50).default(3.0),
});

const tickerParamSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{1,5}$/);

export function adminRoutes(pool: Pool, logger: Logger): Router {
  const router = Router();

  router.get('/watchlist', async (_req, res) => {
    res.json({ watchlist: await selectWatchlist(pool) });
  });

  router.post('/watchlist', async (req, res) => {
    const parsed = watchlistSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', issues: parsed.error.issues });
      return;
    }
    await upsertWatchlistEntry(pool, parsed.data.tickerOrTopic, parsed.data.alertThreshold);
    logger.info('watchlist updated', { ticker: parsed.data.tickerOrTopic });
    res.status(201).json({ ok: true, ...parsed.data });
  });

  router.delete('/watchlist/:ticker', async (req, res) => {
    const ticker = tickerParamSchema.safeParse(req.params.ticker);
    if (!ticker.success) {
      res.status(400).json({ error: 'bad_request' });
      return;
    }
    const removed = await deleteWatchlistEntry(pool, ticker.data);
    if (!removed) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ ok: true });
  });

  return router;
}

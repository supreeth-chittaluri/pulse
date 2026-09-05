import { Router } from 'express';
import { z } from 'zod';
import {
  recentSpikes,
  selectSignals,
  selectStats,
  selectTickerSummaries,
  selectTickerTrend,
  selectSignalsAfterId,
  type Pool,
} from '@pulse/core';

/**
 * Anonymous reads. No auth of any kind: M8's acceptance is that a stranger can
 * open the dashboard with no login, so these must work without a token.
 *
 * Every limit is capped server-side. A public endpoint that honours an
 * unbounded `limit` is a free denial-of-service against our own database.
 */
const MAX_LIMIT = 200;

const signalQuerySchema = z.object({
  ticker: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{1,5}$/)
    .optional(),
  sinceHours: z.coerce.number().int().min(1).max(24 * 30).optional(),
  /**
   * Cursor for clients that poll instead of streaming. Returns only rows newer
   * than this id, oldest first, so a poller can advance without re-reading or
   * missing anything. Needed because a buffering reverse proxy makes SSE
   * undeliverable -- see the transport note in the README.
   */
  afterId: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(50),
});

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(50),
});

const trendQuerySchema = z.object({
  hours: z.coerce.number().int().min(1).max(24 * 30).default(168),
});

const tickerParamSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{1,5}$/, 'ticker must be 1-5 letters');

export function publicRoutes(pool: Pool): Router {
  const router = Router();

  router.get('/stats', async (_req, res) => {
    res.json(await selectStats(pool));
  });

  router.get('/signals', async (req, res) => {
    const parsed = signalQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', issues: parsed.error.issues });
      return;
    }
    const { ticker, sinceHours, afterId, limit } = parsed.data;

    if (afterId !== undefined) {
      const signals = await selectSignalsAfterId(pool, afterId, limit);
      res.json({
        signals,
        // Echoed so a poller never has to derive its own cursor from the rows.
        cursor: signals.length > 0 ? signals[signals.length - 1]!.id : afterId,
      });
      return;
    }

    res.json({
      signals: await selectSignals(pool, {
        ticker,
        since: sinceHours ? new Date(Date.now() - sinceHours * 3_600_000) : undefined,
        limit,
      }),
    });
  });

  router.get('/spikes', async (req, res) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', issues: parsed.error.issues });
      return;
    }
    res.json({ spikes: await recentSpikes(pool, parsed.data.limit) });
  });

  router.get('/tickers', async (req, res) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', issues: parsed.error.issues });
      return;
    }
    res.json({ tickers: await selectTickerSummaries(pool, parsed.data.limit) });
  });

  router.get('/tickers/:ticker', async (req, res) => {
    const ticker = tickerParamSchema.safeParse(req.params.ticker);
    const query = trendQuerySchema.safeParse(req.query);
    if (!ticker.success || !query.success) {
      res.status(400).json({ error: 'bad_request' });
      return;
    }

    const [trend, signals] = await Promise.all([
      selectTickerTrend(pool, ticker.data, query.data.hours),
      selectSignals(pool, { ticker: ticker.data, limit: 25 }),
    ]);

    if (trend.length === 0 && signals.length === 0) {
      res.status(404).json({ error: 'not_found', message: `No signals for ${ticker.data}.` });
      return;
    }
    res.json({ ticker: ticker.data, trend, signals });
  });

  return router;
}

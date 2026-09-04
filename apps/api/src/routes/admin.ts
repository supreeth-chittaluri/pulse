import { Router } from 'express';
import { z } from 'zod';
import {
  deleteWatchlistEntry,
  selectWatchlist,
  upsertWatchlistEntry,
  countUnscoredPosts,
  countRequestsToday,
  type Config,
  type Logger,
  type Pool,
} from '@pulse/core';
import { MinIntervalGate } from '@pulse/sources';
import { createGeminiModel, scorePendingPosts } from '@pulse/scoring';

/**
 * Admin-only. Everything that mutates state or spends a finite resource lives
 * here and nowhere else.
 *
 * The scoring trigger is the one that matters. On a metered API a leaked
 * endpoint costs money; on Gemini's fixed free quota it is a denial of service
 * -- a stranger drains the day's requests and scoring stops until midnight
 * Pacific. M8 re-audits this, and a router test asserts every route in this
 * file sits behind requireRole('admin').
 */
const watchlistSchema = z.object({
  tickerOrTopic: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{1,5}$/, 'ticker must be 1-5 letters'),
  alertThreshold: z.coerce.number().min(0.5).max(50).default(3.0),
});

/**
 * Hard cap on one HTTP-triggered scoring run.
 *
 * At batch size 15 this is four model requests, roughly 25 seconds -- short
 * enough to finish inside any platform's request timeout, and small enough that
 * even a compromised admin token cannot drain the daily quota in one call.
 * Clearing a large backlog is the CLI's job.
 */
const MAX_HTTP_SCORE_POSTS = 60;

const scoreSchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_HTTP_SCORE_POSTS).default(30),
});

const tickerParamSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{1,5}$/);

export function adminRoutes(pool: Pool, config: Config, logger: Logger): Router {
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

  /**
   * Reports the scoring backlog and remaining quota without spending any.
   * Useful on its own, and it keeps the admin UI from needing to guess.
   */
  router.get('/scoring-status', async (_req, res) => {
    const [pending, usedToday] = await Promise.all([
      countUnscoredPosts(pool),
      countRequestsToday(pool, 'gemini'),
    ]);
    res.json({
      pendingPosts: pending,
      batchSize: config.scoring.batchSize,
      estimatedRequests: Math.ceil(pending / config.scoring.batchSize),
      requestsUsedToday: usedToday,
      dailyRequestBudget: config.gemini.dailyRequestBudget,
      model: config.gemini.model,
    });
  });

  /**
   * Spends Gemini quota. The single most sensitive route in the application.
   *
   * Exists because M8 deploys to a platform with no shell, so there must be
   * some way to score without one -- but it is bounded to MAX_HTTP_SCORE_POSTS
   * and sits behind both requireRole('admin') and the stricter admin rate
   * limiter. The tradeoff for having it at all is that the API process now
   * needs GEMINI_API_KEY, widening the blast radius if the API is compromised;
   * the worker would otherwise be the only holder.
   */
  router.post('/score', async (req, res) => {
    const parsed = scoreSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', issues: parsed.error.issues });
      return;
    }
    if (!config.gemini.apiKey) {
      res.status(503).json({
        error: 'scoring_unavailable',
        message: 'GEMINI_API_KEY is not configured on this instance.',
      });
      return;
    }

    logger.info('http scoring triggered', {
      limit: parsed.data.limit,
      by: req.user?.email,
    });

    const summary = await scorePendingPosts(
      {
        pool,
        model: createGeminiModel({ apiKey: config.gemini.apiKey, model: config.gemini.model }),
        gate: new MinIntervalGate(config.gemini.minIntervalMs),
        logger,
      },
      {
        limit: parsed.data.limit,
        batchSize: config.scoring.batchSize,
        dailyRequestBudget: config.gemini.dailyRequestBudget,
      },
    );

    res.json(summary);
  });

  return router;
}

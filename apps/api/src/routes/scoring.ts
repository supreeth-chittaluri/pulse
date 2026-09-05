import { Router } from 'express';
import {
  countUnscoredPosts,
  finishScoreRun,
  reserveScoreRun,
  scoreRunStatus,
  type Config,
  type Logger,
  type Pool,
} from '@pulse/core';
import { createGeminiModel, scorePendingPosts } from '@pulse/scoring';
import { MinIntervalGate } from '@pulse/sources';

/** One button press can score at most four batches of fifteen posts. */
export const SCORE_POST_LIMIT = 60;

/**
 * App-wide, not per visitor. Ten full runs are at most 40 Gemini requests,
 * leaving 90% of Pulse's default 400-request provider safety budget untouched.
 */
export const DAILY_SCORE_RUN_LIMIT = 10;

async function publicStatus(pool: Pool, config: Config) {
  const [pendingPosts, runs] = await Promise.all([
    countUnscoredPosts(pool),
    scoreRunStatus(pool),
  ]);
  return {
    pendingPosts,
    maxPostsPerRun: SCORE_POST_LIMIT,
    batchSize: config.scoring.batchSize,
    estimatedRequestsForNextRun: Math.ceil(
      Math.min(pendingPosts, SCORE_POST_LIMIT) / config.scoring.batchSize,
    ),
    runsUsedToday: runs.usedToday,
    runsRemainingToday: Math.max(0, DAILY_SCORE_RUN_LIMIT - runs.usedToday),
    dailyRunLimit: DAILY_SCORE_RUN_LIMIT,
    resetAt: runs.resetAt,
    running: runs.running,
  };
}

/**
 * Public manual scoring, deliberately separate from ordinary read routes.
 * Spending is bounded in three layers: 60 posts per run, ten durable global
 * runs per Pacific quota day, and the existing 400-request Gemini budget.
 */
export function scoringRoutes(pool: Pool, config: Config, logger: Logger): Router {
  const router = Router();

  router.get('/status', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await publicStatus(pool, config));
  });

  router.post('/run', async (req, res, next) => {
    if (!config.gemini.apiKey) {
      res.status(503).json({
        error: 'scoring_unavailable',
        message: 'Scoring is temporarily unavailable. Please try again later.',
      });
      return;
    }

    const reservation = await reserveScoreRun(pool, DAILY_SCORE_RUN_LIMIT);
    if (reservation.state === 'in_progress') {
      res.status(409).json({
        error: 'scoring_in_progress',
        message: 'A scoring run is already in progress. Please wait for it to finish.',
        status: await publicStatus(pool, config),
      });
      return;
    }
    if (reservation.state === 'limit_reached') {
      const retryAfter = Math.max(
        1,
        Math.ceil((reservation.resetAt.getTime() - Date.now()) / 1000),
      );
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({
        error: 'daily_score_limit_reached',
        message:
          'The daily scoring limit has been used. Please try again after midnight Pacific.',
        status: await publicStatus(pool, config),
      });
      return;
    }

    logger.info('public scoring triggered', {
      runId: reservation.runId,
      by: req.user?.email ?? 'anonymous',
      runsUsedToday: reservation.usedToday,
    });

    try {
      const summary = await scorePendingPosts(
        {
          pool,
          model: createGeminiModel({
            apiKey: config.gemini.apiKey,
            model: config.gemini.model,
          }),
          gate: new MinIntervalGate(config.gemini.minIntervalMs),
          logger,
        },
        {
          limit: SCORE_POST_LIMIT,
          batchSize: config.scoring.batchSize,
          dailyRequestBudget: config.gemini.dailyRequestBudget,
        },
      );
      await finishScoreRun(pool, reservation.runId);
      res.json({
        ok: true,
        summary,
        status: await publicStatus(pool, config),
      });
    } catch (err) {
      try {
        await finishScoreRun(pool, reservation.runId, (err as Error).message);
      } catch (finishError) {
        logger.error('could not close failed score run', {
          runId: reservation.runId,
          error: (finishError as Error).message,
        });
      }
      next(err);
    }
  });

  return router;
}

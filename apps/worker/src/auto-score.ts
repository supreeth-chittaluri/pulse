import {
  finishScoreRun,
  reserveAutomaticScoreRun,
  type Config,
  type Logger,
  type Pool,
} from '@pulse/core';
import { createGeminiModel, scorePendingPosts, triagePendingPosts } from '@pulse/scoring';
import { MinIntervalGate } from '@pulse/sources';

/** One restart-safe automatic scoring slot. */
export async function runAutomaticScoring(
  config: Config,
  pool: Pool,
  logger: Logger,
): Promise<void> {
  if (!config.scoring.autoEnabled) return;
  const reservation = await reserveAutomaticScoreRun(pool, config.scoring.autoIntervalMinutes);
  if (reservation.state !== 'reserved') return;

  try {
    const triage = await triagePendingPosts(
      { pool, logger },
      { limit: config.scoring.triageBatchSize },
    );

    if (!config.gemini.apiKey) {
      logger.warn('automatic Gemini scoring unavailable; local triage still completed', {
        runId: reservation.runId,
        triaged: triage.postsConsidered,
      });
      await finishScoreRun(pool, reservation.runId);
      return;
    }

    const scoring = await scorePendingPosts(
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
        limit: config.scoring.autoPostLimit,
        batchSize: config.scoring.batchSize,
        dailyRequestBudget: config.gemini.dailyRequestBudget,
      },
    );
    await finishScoreRun(pool, reservation.runId);
    logger.info('automatic scoring completed', {
      runId: reservation.runId,
      scheduledFor: reservation.scheduledFor,
      triaged: triage.postsConsidered,
      postsScored: scoring.postsScored,
      signalsWritten: scoring.signalsWritten,
      requestsMade: scoring.requestsMade,
      stoppedEarly: scoring.stoppedEarly,
    });
  } catch (err) {
    try {
      await finishScoreRun(pool, reservation.runId, (err as Error).message);
    } catch (finishError) {
      logger.error('could not close failed automatic scoring run', {
        runId: reservation.runId,
        error: (finishError as Error).message,
      });
    }
    throw err;
  }
}

import {
  countRequestsToday,
  recordLlmRequest,
  recordScoreFailure,
  selectUnscoredPosts,
  writeScores,
  type Logger,
  type Pool,
  type SignalInput,
  type UnscoredPost,
} from '@pulse/core';
import type { MinIntervalGate } from '@pulse/sources';
import { extractCandidates, type Candidate } from './tickers.ts';
import { renderBatch, SYSTEM_PROMPT, type ScorablePost } from './prompt.ts';
import { parseBatchResponse, ValidationError, type PostResult } from './schema.ts';
import { QuotaExceededError, type ScoringModel } from './gemini.ts';

export const GEMINI_RATE_LIMIT_BUCKET = 'gemini';

export type ScoreDeps = {
  pool: Pool;
  model: ScoringModel;
  gate: MinIntervalGate;
  logger: Logger;
};

export type ScoreOptions = {
  /** Maximum posts to pull off the queue. */
  limit: number;
  batchSize: number;
  /** Refuse to start another request once this many have been made today. */
  dailyRequestBudget: number;
  /** Report what would happen without calling the model. */
  dryRun?: boolean;
};

export type ScoreSummary = {
  postsConsidered: number;
  /** Marked scored with zero signals, for free, because no candidate ticker. */
  skippedNoCandidates: number;
  postsSent: number;
  postsScored: number;
  signalsWritten: number;
  requestsMade: number;
  requestsRemainingToday: number;
  inputTokens: number;
  outputTokens: number;
  failures: number;
  stoppedEarly: string | null;
};

function excerptFor(post: UnscoredPost): string {
  const body = post.body?.trim();
  const text = body ? `${post.title}\n\n${body}` : post.title;
  return text.length > 1000 ? `${text.slice(0, 1000)}...` : text;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Turns one validated per-post result into rows for the signals table. */
function toSignals(result: PostResult, post: UnscoredPost, candidates: Candidate[]): SignalInput[] {
  const allowed = new Set(candidates.map((c) => c.ticker));
  const excerpt = excerptFor(post);

  return result.tickers
    // A ticker we never offered is a hallucination; drop it rather than store it.
    .filter((verdict) => allowed.has(verdict.ticker) && verdict.is_ticker_mention)
    .map((verdict) => ({
      tickerOrTopic: verdict.ticker,
      sentimentScore: verdict.sentiment_score,
      confidence: verdict.confidence,
      rawExcerpt: excerpt,
    }));
}

/**
 * Scores pending posts.
 *
 * Shape of the work:
 *   1. Pull unscored posts.
 *   2. Extract candidate tickers locally. No candidates -> mark scored, zero
 *      quota spent. This is most of the queue on general-interest feeds.
 *   3. Batch the survivors and send each batch to the model.
 *   4. Validate hard, write signals and scored_at in one transaction.
 *
 * On a validation failure the whole batch is retried ONE post per request, so a
 * single malformed entry cannot cost fourteen good posts their scoring.
 */
export async function scorePendingPosts(
  deps: ScoreDeps,
  options: ScoreOptions,
): Promise<ScoreSummary> {
  const { pool, model, logger } = deps;
  const { limit, batchSize, dailyRequestBudget, dryRun = false } = options;

  const summary: ScoreSummary = {
    postsConsidered: 0,
    skippedNoCandidates: 0,
    postsSent: 0,
    postsScored: 0,
    signalsWritten: 0,
    requestsMade: 0,
    requestsRemainingToday: 0,
    inputTokens: 0,
    outputTokens: 0,
    failures: 0,
    stoppedEarly: null,
  };

  const usedToday = await countRequestsToday(pool, model.provider);
  summary.requestsRemainingToday = Math.max(0, dailyRequestBudget - usedToday);

  const posts = await selectUnscoredPosts(pool, limit);
  summary.postsConsidered = posts.length;
  if (posts.length === 0) return summary;

  // Step 2: the free half.
  const scorable: Array<{ post: UnscoredPost; candidates: Candidate[] }> = [];
  for (const post of posts) {
    const text = post.body ? `${post.title}\n${post.body}` : post.title;
    const candidates = extractCandidates(text);
    if (candidates.length === 0) {
      if (!dryRun) await writeScores(pool, post.id, post.source, []);
      summary.skippedNoCandidates += 1;
    } else {
      scorable.push({ post, candidates });
    }
  }

  const batches = chunk(scorable, batchSize);
  summary.postsSent = scorable.length;

  if (dryRun) {
    summary.requestsMade = batches.length;
    return summary;
  }

  for (const batch of batches) {
    if (usedToday + summary.requestsMade >= dailyRequestBudget) {
      summary.stoppedEarly =
        `Daily request budget of ${dailyRequestBudget} reached ` +
        `(${usedToday} already used today). Raise GEMINI_DAILY_REQUEST_BUDGET ` +
        'after checking https://aistudio.google.com/rate-limit, or wait for the ' +
        'midnight-Pacific reset.';
      break;
    }

    try {
      const written = await runBatch(deps, batch);
      summary.requestsMade += written.requests;
      summary.postsScored += written.postsScored;
      summary.signalsWritten += written.signals;
      summary.inputTokens += written.inputTokens;
      summary.outputTokens += written.outputTokens;
      summary.failures += written.failures;
    } catch (err) {
      summary.requestsMade += 1;
      if (err instanceof QuotaExceededError) {
        summary.stoppedEarly = (err as Error).message;
        logger.error('stopping: provider quota reached', { error: (err as Error).message });
        break;
      }
      summary.failures += batch.length;
      logger.error('batch failed', { posts: batch.length, error: (err as Error).message });
      await recordScoreFailure(pool, batch.map((b) => b.post.id), (err as Error).message);
    }
  }

  summary.requestsRemainingToday = Math.max(0, dailyRequestBudget - usedToday - summary.requestsMade);
  return summary;
}

type BatchOutcome = {
  requests: number;
  postsScored: number;
  signals: number;
  inputTokens: number;
  outputTokens: number;
  failures: number;
};

async function runBatch(
  deps: ScoreDeps,
  batch: Array<{ post: UnscoredPost; candidates: Candidate[] }>,
): Promise<BatchOutcome> {
  const { pool, model, gate, logger } = deps;

  const scorable: ScorablePost[] = batch.map(({ post, candidates }) => ({
    id: post.id,
    source: post.source,
    title: post.title,
    body: post.body,
    candidates,
  }));
  const expectedIds = scorable.map((p) => p.id);

  await gate.acquire(GEMINI_RATE_LIMIT_BUCKET);

  const outcome: BatchOutcome = {
    requests: 1,
    postsScored: 0,
    signals: 0,
    inputTokens: 0,
    outputTokens: 0,
    failures: 0,
  };

  let response;
  try {
    response = await model.generate(SYSTEM_PROMPT, renderBatch(scorable));
  } catch (err) {
    await recordLlmRequest(pool, {
      provider: model.provider,
      model: model.model,
      postsInBatch: batch.length,
      error: (err as Error).message,
    });
    throw err;
  }

  await recordLlmRequest(pool, {
    provider: model.provider,
    model: model.model,
    postsInBatch: batch.length,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    durationMs: response.durationMs,
  });
  outcome.inputTokens += response.inputTokens ?? 0;
  outcome.outputTokens += response.outputTokens ?? 0;

  let parsed;
  try {
    parsed = parseBatchResponse(response.text, expectedIds);
  } catch (err) {
    if (err instanceof ValidationError && batch.length > 1) {
      // One bad entry must not cost the whole batch. Retry singly.
      logger.warn('batch response invalid; retrying posts individually', {
        posts: batch.length,
        error: err.message,
        detail: err.detail,
      });
      for (const single of batch) {
        try {
          const one = await runBatch(deps, [single]);
          outcome.requests += one.requests;
          outcome.postsScored += one.postsScored;
          outcome.signals += one.signals;
          outcome.inputTokens += one.inputTokens;
          outcome.outputTokens += one.outputTokens;
          outcome.failures += one.failures;
        } catch (singleErr) {
          if (singleErr instanceof QuotaExceededError) throw singleErr;
          outcome.failures += 1;
          await recordScoreFailure(pool, [single.post.id], (singleErr as Error).message);
        }
      }
      return outcome;
    }
    throw err;
  }

  const byId = new Map(batch.map((b) => [b.post.id, b]));
  for (const result of parsed.results) {
    const entry = byId.get(result.post_id)!;
    const signals = toSignals(result, entry.post, entry.candidates);
    outcome.signals += await writeScores(pool, entry.post.id, entry.post.source, signals);
    outcome.postsScored += 1;
  }

  logger.info('scored batch', {
    posts: batch.length,
    signals: outcome.signals,
    durationMs: response.durationMs,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
  });

  return outcome;
}

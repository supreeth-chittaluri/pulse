import {
  selectUntriagedPosts,
  writeTriageResults,
  type Logger,
  type Pool,
} from '@pulse/core';
import { extractCandidates } from './tickers.ts';

export type TriageSummary = {
  postsConsidered: number;
  postsCompletedFree: number;
  postsQueuedForGemini: number;
};

/** Runs the deterministic, zero-cost half of scoring and persists its result. */
export async function triagePendingPosts(
  deps: { pool: Pool; logger: Logger },
  options: { limit: number },
): Promise<TriageSummary> {
  const posts = await selectUntriagedPosts(deps.pool, options.limit);
  const results = posts.map((post) => {
    const text = post.body ? `${post.title}\n${post.body}` : post.title;
    return { id: post.id, candidates: extractCandidates(text) };
  });

  await writeTriageResults(deps.pool, results);
  const postsQueuedForGemini = results.filter((result) => result.candidates.length > 0).length;
  const summary = {
    postsConsidered: results.length,
    postsCompletedFree: results.length - postsQueuedForGemini,
    postsQueuedForGemini,
  };
  if (summary.postsConsidered > 0) deps.logger.info('triaged posts', summary);
  return summary;
}

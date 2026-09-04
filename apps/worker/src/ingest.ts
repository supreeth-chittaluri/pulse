import {
  finishRun,
  insertPosts,
  startRun,
  type Logger,
  type Pool,
} from '@pulse/core';
import type { MinIntervalGate, Source } from '@pulse/sources';

export type IngestDeps = {
  pool: Pool;
  gate: MinIntervalGate;
  logger: Logger;
};

export type IngestResult = {
  source: string;
  adapter: string;
  fetched: number;
  inserted: number;
  durationMs: number;
};

/**
 * Ingests one source: wait for the rate-limit gate, fetch, insert with dedupe,
 * and record the attempt in ingest_runs either way.
 *
 * Throws on failure so the scheduler can apply per-source backoff -- but the
 * ingest_runs row is always closed out first, so a failing feed is visible in
 * the database and not only in the logs.
 */
export async function ingestSource(
  deps: IngestDeps,
  source: Source,
  signal?: AbortSignal,
): Promise<IngestResult> {
  const { pool, gate, logger } = deps;

  const waitMs = gate.waitTimeMs(source.rateLimitBucket);
  if (waitMs > 0) {
    logger.debug('waiting on rate-limit gate', {
      source: source.id,
      bucket: source.rateLimitBucket,
      waitMs,
    });
  }
  // Throws AbortedError if we are shutting down, before any ingest_runs row
  // is opened -- so an interrupted wait leaves no half-finished record.
  await gate.acquire(source.rateLimitBucket, signal);

  const startedAt = Date.now();
  const runId = await startRun(pool, source.id, source.adapter);

  try {
    const posts = await source.fetch();
    const { inserted } = await insertPosts(pool, posts);
    const durationMs = Date.now() - startedAt;

    await finishRun(pool, runId, { postsFetched: posts.length, postsInserted: inserted });

    logger.info('ingested', {
      source: source.id,
      adapter: source.adapter,
      fetched: posts.length,
      inserted,
      durationMs,
    });

    return { source: source.id, adapter: source.adapter, fetched: posts.length, inserted, durationMs };
  } catch (err) {
    const message = (err as Error).message;
    await finishRun(pool, runId, {
      postsFetched: 0,
      postsInserted: 0,
      // The column is plain text; keep it bounded so a giant HTML error body
      // cannot bloat the table.
      error: message.slice(0, 1000),
    }).catch((writeErr: unknown) => {
      logger.error('could not record failed run', { runId, error: (writeErr as Error).message });
    });

    logger.error('ingest failed', { source: source.id, adapter: source.adapter, error: message });
    throw err;
  }
}

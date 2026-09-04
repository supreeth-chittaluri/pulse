export { loadConfig, resetConfigCache, type Config } from './config.ts';
export { createPool, type Pool } from './db.ts';
export { createLogger, type Logger } from './logger.ts';
export type { RawPost, Signal, UserRole } from './types.ts';
export {
  insertPosts,
  countPosts,
  countPostsBySource,
  type InsertPostsResult,
  type SourceCount,
} from './repositories/posts.ts';
export {
  startRun,
  finishRun,
  lastRunPerSource,
  type FinishRunInput,
  type LastRun,
} from './repositories/runs.ts';
export {
  selectUnscoredPosts,
  countUnscoredPosts,
  writeScores,
  recordScoreFailure,
  recordLlmRequest,
  countRequestsToday,
  countSignals,
  type UnscoredPost,
  type SignalInput,
  type LlmRequestRecord,
} from './repositories/signals.ts';
export {
  selectObservationsSince,
  upsertBaseline,
  insertSpike,
  lastSpikePerTicker,
  watchlistThresholds,
  recentSpikes,
  type SignalObservation,
  type BaselineRow,
  type SpikeRow,
  type RecentSpike,
} from './repositories/spikes.ts';

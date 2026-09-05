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
  selectSpikesAfterId,
  type SignalObservation,
  type BaselineRow,
  type SpikeRow,
  type RecentSpike,
} from './repositories/spikes.ts';
export { makeTestConfig } from './test-config.ts';
export {
  findUserByEmail,
  upsertUser,
  recordLogin,
  countUsers,
  normalizeEmail,
  type User,
} from './repositories/users.ts';
export {
  selectSignals,
  selectTickerSummaries,
  selectTickerTrend,
  selectStats,
  selectWatchlist,
  upsertWatchlistEntry,
  deleteWatchlistEntry,
  type SignalRow,
  type SignalQuery,
  type TickerSummary,
  type TrendPoint,
  type Stats,
  type WatchlistEntry,
  selectSignalsAfterId,
  selectMaxIds,
  type MaxIds,
} from './repositories/queries.ts';
export {
  selectAlertableSpikes,
  recordAlert,
  countAlertsToday,
  recentAlerts,
  type PendingSpike,
  type AlertRecord,
  type SentAlert,
} from './repositories/alerts.ts';

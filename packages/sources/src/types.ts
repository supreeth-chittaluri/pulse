import type { RawPost } from '@pulse/core';

/**
 * Every ingestion source implements this and nothing else. M1's pipeline never
 * learns whether a post arrived over Reddit RSS, Reddit OAuth, or a news feed
 * -- which is the whole point, given Reddit API approval is out of our hands.
 */
export interface Source {
  /** Stable id, also written to posts.source. e.g. "reddit:wallstreetbets". */
  readonly id: string;
  /** Which adapter is actually behind this source, for logging and /health. */
  readonly adapter: string;
  /** How often the scheduler should poll it. */
  readonly pollSeconds: number;
  /**
   * Sources sharing a bucket queue behind one another through a MinIntervalGate.
   * Null means the source has no client-wide limit worth respecting.
   */
  readonly rateLimitBucket: string | null;
  fetch(): Promise<RawPost[]>;
}

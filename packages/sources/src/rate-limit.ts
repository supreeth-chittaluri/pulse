/**
 * Injectable clock so tests can assert scheduling decisions without burning
 * real seconds. Production uses `systemClock`.
 */
export type Clock = {
  now(): number;
  sleep(ms: number): Promise<void>;
};

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Enforces a minimum gap between requests sharing a bucket.
 *
 * This exists because Reddit's .rss limiter is per-CLIENT across every feed,
 * not per feed: fetching three different subreddits back to back returns 429.
 * So all Reddit adapters share the bucket "reddit" and queue behind each other,
 * while unrelated sources (Hacker News, Google News) pass straight through.
 *
 * Callers queue in arrival order, and the gap is measured from acquire to
 * acquire rather than from completion, so a slow request does not compound
 * into an even longer wait for whoever is next in line.
 */
export class MinIntervalGate {
  readonly minIntervalMs: number;
  #clock: Clock;
  #chains = new Map<string, Promise<void>>();
  #lastAcquiredAt = new Map<string, number>();

  constructor(minIntervalMs: number, clock: Clock = systemClock) {
    if (minIntervalMs < 0) throw new RangeError('minIntervalMs must be >= 0');
    this.minIntervalMs = minIntervalMs;
    this.#clock = clock;
  }

  /**
   * Resolves once the caller is clear to issue a request. A null bucket means
   * "unlimited" and resolves immediately.
   */
  async acquire(bucket: string | null): Promise<void> {
    if (bucket === null) return;

    const prior = this.#chains.get(bucket) ?? Promise.resolve();
    const turn = prior.then(async () => {
      const last = this.#lastAcquiredAt.get(bucket);
      if (last !== undefined) {
        const waitMs = this.minIntervalMs - (this.#clock.now() - last);
        if (waitMs > 0) await this.#clock.sleep(waitMs);
      }
      this.#lastAcquiredAt.set(bucket, this.#clock.now());
    });

    // The stored chain swallows rejections; otherwise one failure would poison
    // the queue for every later caller in that bucket.
    this.#chains.set(
      bucket,
      turn.catch(() => {}),
    );
    await turn;
  }

  /** Milliseconds until the bucket is next free. Zero when it is free now. */
  waitTimeMs(bucket: string | null): number {
    if (bucket === null) return 0;
    const last = this.#lastAcquiredAt.get(bucket);
    if (last === undefined) return 0;
    return Math.max(0, this.minIntervalMs - (this.#clock.now() - last));
  }
}

/**
 * Concurrency accounting for live SSE connections.
 *
 * Extracted from the route because it is the part with real logic worth
 * testing, and testing it through a socket is unreliable: whether a client
 * disconnect is observed depends on the HTTP client, its connection pooling,
 * and (in-process) on socket-close delivery. The registry has none of that
 * ambiguity.
 *
 * Bounds exist because a public endpoint holding sockets open is a memory
 * exhaustion vector, and the request rate limiter cannot help -- one SSE
 * connection is a single request that then lives for hours. Concurrency, not
 * rate, is the thing to bound here.
 */
export type AcquireResult =
  | { ok: true }
  | { ok: false; status: 503; reason: 'stream_unavailable' }
  | { ok: false; status: 429; reason: 'too_many_streams' };

export type RegistryOptions = {
  maxConnections: number;
  maxConnectionsPerIp: number;
};

export class ConnectionRegistry {
  readonly maxConnections: number;
  readonly maxConnectionsPerIp: number;
  #perIp = new Map<string, number>();
  #total = 0;

  constructor(options: RegistryOptions) {
    this.maxConnections = options.maxConnections;
    this.maxConnectionsPerIp = options.maxConnectionsPerIp;
  }

  get total(): number {
    return this.#total;
  }

  countFor(ip: string): number {
    return this.#perIp.get(ip) ?? 0;
  }

  /** Number of distinct clients holding a connection. Zero when fully drained. */
  get clients(): number {
    return this.#perIp.size;
  }

  acquire(ip: string): AcquireResult {
    if (this.#total >= this.maxConnections) {
      return { ok: false, status: 503, reason: 'stream_unavailable' };
    }
    if (this.countFor(ip) >= this.maxConnectionsPerIp) {
      return { ok: false, status: 429, reason: 'too_many_streams' };
    }
    this.#total += 1;
    this.#perIp.set(ip, this.countFor(ip) + 1);
    return { ok: true };
  }

  /**
   * Releases one slot. Callers guard against double-release themselves, but
   * this refuses to go negative regardless -- a counter that drifts below zero
   * would silently raise the effective cap forever.
   */
  release(ip: string): void {
    if (this.#total > 0) this.#total -= 1;
    const remaining = this.countFor(ip) - 1;
    if (remaining <= 0) this.#perIp.delete(ip);
    else this.#perIp.set(ip, remaining);
  }

  reset(): void {
    this.#perIp.clear();
    this.#total = 0;
  }
}

import {
  selectMaxIds,
  selectSignalsAfterId,
  selectSpikesAfterId,
  type Logger,
  type Pool,
} from '@pulse/core';

/**
 * Cursor into both streams.
 *
 * Signals and spikes are separate tables with independent id sequences, so a
 * single number cannot address a position in the combined stream. Every event
 * carries the full pair, which is what makes SSE's Last-Event-ID resume exact
 * rather than approximate.
 */
export type Cursor = { signalId: number; spikeId: number };

export type StreamEvent = {
  name: 'signal' | 'spike';
  cursor: Cursor;
  payload: unknown;
};

export type Subscriber = (event: StreamEvent) => void;

export type HubOptions = {
  pool: Pool;
  logger: Logger;
  /**
   * Scoring writes ~15 signals in a burst, so a short coalescing delay turns a
   * stampede of notifications into one query and one flush.
   */
  debounceMs?: number;
  maxRowsPerFlush?: number;
};

export function formatCursor(cursor: Cursor): string {
  return `${cursor.signalId}-${cursor.spikeId}`;
}

/** Parses a Last-Event-ID header. Returns null for anything malformed. */
export function parseCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  const match = /^(\d{1,18})-(\d{1,18})$/.exec(raw.trim());
  if (!match) return null;
  return { signalId: Number(match[1]), spikeId: Number(match[2]) };
}

/**
 * Fans new rows out to connected SSE clients.
 *
 * The hub owns a cursor and re-queries from it, so a NOTIFY payload is only a
 * wake-up call. That matters: a notification dropped while no listener was
 * connected would otherwise mean a permanently missed row, whereas here the
 * next wake-up picks it up.
 */
export class StreamHub {
  #pool: Pool;
  #logger: Logger;
  #debounceMs: number;
  #maxRows: number;
  #subscribers = new Set<Subscriber>();
  #cursor: Cursor = { signalId: 0, spikeId: 0 };
  #timer: NodeJS.Timeout | undefined;
  #flushing = false;
  #pending = false;

  constructor(options: HubOptions) {
    this.#pool = options.pool;
    this.#logger = options.logger;
    this.#debounceMs = options.debounceMs ?? 100;
    this.#maxRows = options.maxRowsPerFlush ?? 200;
  }

  /**
   * Seeds the cursor at the current maximum so a fresh process does not replay
   * the entire table to its first subscriber.
   */
  async initialize(): Promise<void> {
    this.#cursor = await selectMaxIds(this.#pool);
  }

  get cursor(): Cursor {
    return { ...this.#cursor };
  }

  get subscriberCount(): number {
    return this.#subscribers.size;
  }

  subscribe(subscriber: Subscriber): () => void {
    this.#subscribers.add(subscriber);
    return () => {
      this.#subscribers.delete(subscriber);
    };
  }

  /** Schedules a coalesced flush. Safe to call as often as notifications arrive. */
  wake(): void {
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.flush();
    }, this.#debounceMs);
    // A pending flush must never hold the process open at shutdown.
    this.#timer.unref?.();
  }

  /**
   * Reads everything past the cursor and publishes it.
   *
   * Serialized: a flush that arrives while one is running sets a flag and runs
   * afterwards, so two overlapping flushes cannot read the same rows and
   * deliver them twice.
   */
  async flush(): Promise<void> {
    if (this.#flushing) {
      this.#pending = true;
      return;
    }
    this.#flushing = true;

    try {
      do {
        this.#pending = false;

        const [signals, spikes] = await Promise.all([
          selectSignalsAfterId(this.#pool, this.#cursor.signalId, this.#maxRows),
          selectSpikesAfterId(this.#pool, this.#cursor.spikeId, this.#maxRows),
        ]);

        for (const signal of signals) {
          this.#cursor = { ...this.#cursor, signalId: signal.id };
          this.#publish({ name: 'signal', cursor: this.cursor, payload: signal });
        }
        for (const spike of spikes) {
          this.#cursor = { ...this.#cursor, spikeId: spike.id };
          this.#publish({ name: 'spike', cursor: this.cursor, payload: spike });
        }

        // A full page means there is probably more waiting.
        if (signals.length === this.#maxRows || spikes.length === this.#maxRows) {
          this.#pending = true;
        }
      } while (this.#pending);
    } catch (err) {
      this.#logger.error('stream flush failed', { error: (err as Error).message });
    } finally {
      this.#flushing = false;
    }
  }

  /** Rows a reconnecting client missed, replayed from its Last-Event-ID. */
  async backfill(from: Cursor, limit: number): Promise<StreamEvent[]> {
    const [signals, spikes] = await Promise.all([
      selectSignalsAfterId(this.#pool, from.signalId, limit),
      selectSpikesAfterId(this.#pool, from.spikeId, limit),
    ]);

    const events: StreamEvent[] = [];
    let cursor = { ...from };
    for (const signal of signals) {
      cursor = { ...cursor, signalId: signal.id };
      events.push({ name: 'signal', cursor: { ...cursor }, payload: signal });
    }
    for (const spike of spikes) {
      cursor = { ...cursor, spikeId: spike.id };
      events.push({ name: 'spike', cursor: { ...cursor }, payload: spike });
    }
    return events;
  }

  #publish(event: StreamEvent): void {
    for (const subscriber of this.#subscribers) {
      try {
        subscriber(event);
      } catch (err) {
        // One broken client must not stop delivery to the others.
        this.#logger.warn('subscriber threw', { error: (err as Error).message });
      }
    }
  }

  close(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#subscribers.clear();
  }
}

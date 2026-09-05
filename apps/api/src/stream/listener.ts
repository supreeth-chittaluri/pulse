import pg from 'pg';
import type { Logger } from '@pulse/core';

/**
 * A source of "something changed" wake-ups for the hub.
 *
 * Two implementations, chosen at runtime for the same reason the Reddit
 * adapters are: the better option is not always available, and a deployment
 * detail should not be able to silently kill the feature.
 */
export interface ChangeListener {
  readonly kind: 'notify' | 'poll';
  start(onChange: () => void): Promise<void>;
  stop(): Promise<void>;
}

export const CHANNELS = ['pulse_signal', 'pulse_spike'] as const;

/**
 * Postgres LISTEN/NOTIFY. Sub-second latency and no polling load.
 *
 * Needs a dedicated connection held open outside the pool -- LISTEN is
 * connection-scoped, so a pooled connection would stop listening the moment it
 * was handed to someone else.
 */
export function createNotifyListener(
  databaseUrl: string,
  logger: Logger,
  onDrop?: () => void,
): ChangeListener {
  let client: pg.Client | undefined;
  let stopped = false;

  return {
    kind: 'notify',

    async start(onChange: () => void): Promise<void> {
      const connection = new pg.Client({
        connectionString: databaseUrl,
        ssl: /\blocalhost\b|\b127\.0\.0\.1\b/.test(databaseUrl)
          ? undefined
          : { rejectUnauthorized: false },
      });

      connection.on('notification', () => onChange());
      connection.on('error', (err: Error) => {
        // The connection can die long after a successful start (idle timeout,
        // failover, a pooler closing it). Report it so the caller can fall back
        // rather than sitting on a stream that will never deliver again.
        if (stopped) return;
        logger.error('notify listener connection lost', { error: err.message });
        onDrop?.();
      });

      await connection.connect();
      for (const channel of CHANNELS) {
        await connection.query(`listen ${channel}`);
      }
      client = connection;
      logger.info('stream listening via LISTEN/NOTIFY', { channels: [...CHANNELS] });
    },

    async stop(): Promise<void> {
      stopped = true;
      await client?.end().catch(() => {});
      client = undefined;
    },
  };
}

/**
 * Polling fallback.
 *
 * Exists because Neon's pooled connection string (pgBouncer) does not support
 * LISTEN/NOTIFY, and that is exactly the URL a free-tier deploy is most likely
 * to be handed. Two seconds of latency beats a stream that never fires.
 */
export function createPollListener(intervalMs: number, logger: Logger): ChangeListener {
  let timer: NodeJS.Timeout | undefined;

  return {
    kind: 'poll',

    async start(onChange: () => void): Promise<void> {
      timer = setInterval(onChange, intervalMs);
      timer.unref?.();
      logger.info('stream falling back to polling', { intervalMs });
    },

    async stop(): Promise<void> {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}

/**
 * Prefers LISTEN/NOTIFY, falls back to polling if it cannot be established.
 *
 * The fallback also arms if the notify connection drops later, so a mid-life
 * failure degrades to slower delivery instead of silence.
 */
export async function createChangeListener(options: {
  databaseUrl: string;
  logger: Logger;
  pollIntervalMs?: number;
  onChange: () => void;
  /** Test seam: forces the fallback path. */
  disableNotify?: boolean;
}): Promise<ChangeListener> {
  const { databaseUrl, logger, pollIntervalMs = 2000, onChange, disableNotify } = options;

  let active: ChangeListener | undefined;
  let fellBack = false;

  const fallBack = async (reason: string): Promise<void> => {
    if (fellBack) return;
    fellBack = true;
    logger.warn('stream: switching to polling', { reason });
    await active?.stop().catch(() => {});
    active = createPollListener(pollIntervalMs, logger);
    await active.start(onChange);
  };

  if (!disableNotify) {
    try {
      const notify = createNotifyListener(databaseUrl, logger, () => {
        void fallBack('notify connection lost');
      });
      await notify.start(onChange);
      active = notify;
    } catch (err) {
      await fallBack((err as Error).message);
    }
  } else {
    await fallBack('notify disabled');
  }

  const current = active!;
  return {
    get kind() {
      return (active ?? current).kind;
    },
    async start() {
      /* already started */
    },
    async stop() {
      await (active ?? current).stop();
    },
  };
}

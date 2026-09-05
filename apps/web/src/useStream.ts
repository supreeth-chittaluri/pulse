import { useEffect, useRef, useState } from 'react';
import { api, type Signal, type Spike } from './api.ts';

export type Transport = 'connecting' | 'stream' | 'polling' | 'offline';

export type StreamHandlers = {
  onSignal?: (signal: Signal) => void;
  onSpike?: (spike: Spike) => void;
};

/**
 * How long to wait for the stream to prove itself before falling back.
 *
 * The server sends a `ready` event immediately on connect, so anything longer
 * than a slow handshake means the bytes are not getting through.
 */
const STREAM_PROOF_MS = 6000;
const POLL_INTERVAL_MS = 5000;

/**
 * Live updates, over SSE where that works and polling where it does not.
 *
 * The fallback is not defensive padding -- it is required. A reverse proxy that
 * buffers responses until they complete (Cloudflare in front of Render, which is
 * where this deploys) makes SSE undeliverable: the server writes events, the
 * proxy holds every byte, and the client waits forever on a connection that
 * looks open. Measured on the deployment, a response written in ten chunks
 * 300ms apart arrived as a single burst when it ended.
 *
 * So the browser does not trust the connection opening. It waits for an actual
 * event, and if none arrives it switches to cursor-based polling — which works
 * anywhere, because each response completes.
 */
export function useStream(handlers: StreamHandlers): Transport {
  const [transport, setTransport] = useState<Transport>('connecting');

  // Handlers live in a ref so re-renders do not tear down the connection.
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    let cancelled = false;
    let source: EventSource | undefined;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let proofTimer: ReturnType<typeof setTimeout> | undefined;
    let streamProven = false;
    let cursor = 0;

    function handleSignal(signal: Signal): void {
      cursor = Math.max(cursor, signal.id);
      ref.current.onSignal?.(signal);
    }

    async function pollOnce(): Promise<void> {
      if (cancelled) return;
      try {
        const { signals, cursor: next } = await api.signalsAfter(cursor, 50);
        for (const signal of signals) handleSignal(signal);
        if (typeof next === 'number') cursor = Math.max(cursor, next);
        if (!cancelled) setTransport('polling');
      } catch {
        if (!cancelled) setTransport('offline');
      } finally {
        if (!cancelled) pollTimer = setTimeout(() => void pollOnce(), POLL_INTERVAL_MS);
      }
    }

    function fallBackToPolling(): void {
      if (cancelled) return;
      source?.close();
      source = undefined;
      void pollOnce();
    }

    // Establish the cursor first, so a fallback does not replay the whole feed.
    void api
      .signals(1)
      .then(({ signals }) => {
        if (signals[0]) cursor = signals[0].id;
      })
      .catch(() => {})
      .finally(() => {
        if (cancelled) return;

        source = new EventSource('/api/stream');

        // Opening proves nothing: a buffering proxy returns headers promptly
        // and then withholds every byte of the body.
        proofTimer = setTimeout(fallBackToPolling, STREAM_PROOF_MS);

        const proven = (): void => {
          streamProven = true;
          clearTimeout(proofTimer);
          if (!cancelled) setTransport('stream');
        };

        source.addEventListener('ready', proven);
        source.addEventListener('signal', (event) => {
          proven();
          try {
            handleSignal(JSON.parse((event as MessageEvent<string>).data) as Signal);
          } catch {
            /* a malformed frame must not kill the stream */
          }
        });
        source.addEventListener('spike', (event) => {
          proven();
          try {
            ref.current.onSpike?.(JSON.parse((event as MessageEvent<string>).data) as Spike);
          } catch {
            /* ignore */
          }
        });

        // EventSource reports `error` on every reconnect attempt too, so this
        // is not necessarily fatal -- but if it fires before the stream has
        // ever delivered anything, polling is the better bet.
        source.addEventListener('error', () => {
          // Once the stream has actually delivered something, an error is just
          // EventSource reconnecting, which it handles itself.
          if (streamProven) return;
          fallBackToPolling();
        });
      });

    return () => {
      cancelled = true;
      clearTimeout(proofTimer);
      clearTimeout(pollTimer);
      source?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return transport;
}

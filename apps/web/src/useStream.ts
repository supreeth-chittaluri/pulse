import { useEffect, useRef, useState } from 'react';
import type { Signal, Spike } from './api.ts';

export type ConnectionState = 'connecting' | 'live' | 'reconnecting';

export type StreamHandlers = {
  onSignal?: (signal: Signal) => void;
  onSpike?: (spike: Spike) => void;
};

/**
 * Subscribes to the server's SSE feed.
 *
 * Reconnection is deliberately not implemented here: EventSource already
 * retries on its own and replays `Last-Event-ID`, and the server honours that
 * by resending exactly what was missed. Hand-rolled retry logic would fight it
 * and lose the gap-free replay.
 */
export function useStream(handlers: StreamHandlers): ConnectionState {
  const [state, setState] = useState<ConnectionState>('connecting');

  // Handlers are stashed in a ref so a re-render with new closures does not
  // tear down and re-open the connection -- which would drop the feed on every
  // state update and hammer the server's connection cap.
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    const source = new EventSource('/api/stream');

    source.addEventListener('open', () => setState('live'));
    source.addEventListener('error', () => {
      // EventSource reports error on every reconnect attempt too, so this is a
      // transient state rather than a failure.
      setState((current) => (current === 'live' ? 'reconnecting' : current));
    });
    source.addEventListener('ready', () => setState('live'));

    source.addEventListener('signal', (event) => {
      try {
        ref.current.onSignal?.(JSON.parse((event as MessageEvent<string>).data) as Signal);
      } catch {
        /* a malformed frame must not kill the stream */
      }
    });

    source.addEventListener('spike', (event) => {
      try {
        ref.current.onSpike?.(JSON.parse((event as MessageEvent<string>).data) as Spike);
      } catch {
        /* ignore */
      }
    });

    return () => source.close();
  }, []);

  return state;
}

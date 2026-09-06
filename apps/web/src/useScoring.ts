import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type ScoringStatus } from './api.ts';

export const LIMIT_MESSAGE =
  'The daily scoring limit has been used. It resets at midnight Pacific.';

export type Scoring = {
  status: ScoringStatus | null;
  /** True once a status fetch has failed and none has ever succeeded. */
  unavailable: boolean;
  busy: boolean;
  message: string | null;
  error: string | null;
  queueSize: number;
  limitReached: boolean;
  disabled: boolean;
  label: string;
  run: () => Promise<void>;
  refresh: () => Promise<void>;
};

/**
 * Owns the shared state behind "Score now".
 *
 * It lives in one hook rather than in the button because the sidebar control
 * and the Scoring page render the same run: two independent copies would show
 * two different remaining-run counts, and the one you were not looking at would
 * be the accurate one.
 */
export function useScoring(onScored: () => Promise<void>): Scoring {
  const [status, setStatus] = useState<ScoringStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.scoringStatus());
      setUnavailable(false);
    } catch {
      // The dashboard stays useful without this optional control, but saying so
      // beats a spinner that never resolves.
      setUnavailable(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const limitReached = status !== null && status.runsRemainingToday <= 0;
  const queueSize = (status?.triagePendingPosts ?? 0) + (status?.pendingPosts ?? 0);
  const disabled =
    busy || Boolean(status?.running) || queueSize === 0 || status === null || limitReached;

  const run = useCallback(async () => {
    if (limitReached) {
      setError(LIMIT_MESSAGE);
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await api.scoreNow();
      setStatus(result.status);
      const processed = result.summary.postsScored + result.triage.postsCompletedFree;
      setMessage(
        processed === 0
          ? 'The queue is already caught up.'
          : `Processed ${processed} posts and added ${result.summary.signalsWritten} new signals.`,
      );
      await onScored();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Scoring failed. Please try again later.');
    } finally {
      setBusy(false);
      await refresh();
    }
  }, [limitReached, onScored, refresh]);

  const label = unavailable
    ? 'Scoring unavailable'
    : busy
    ? 'Scoring…'
    : status?.running
      ? 'Run in progress'
      : limitReached
        ? 'Daily limit reached'
        : queueSize === 0 && status !== null
          ? 'Queue is empty'
          : 'Score now';

  return {
    status,
    unavailable,
    busy,
    message,
    error,
    queueSize,
    limitReached,
    disabled: disabled || unavailable,
    label,
    run,
    refresh,
  };
}

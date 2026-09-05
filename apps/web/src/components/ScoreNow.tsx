import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type ScoringStatus } from '../api.ts';

const LIMIT_MESSAGE =
  'The daily scoring limit has been used. Please try again after midnight Pacific.';

export function ScoreNow({ onScored }: { onScored: () => Promise<void> }) {
  const [status, setStatus] = useState<ScoringStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await api.scoringStatus());
    } catch {
      // The dashboard remains useful if this optional control is unavailable.
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
    const timer = window.setInterval(() => void refreshStatus(), 15_000);
    return () => window.clearInterval(timer);
  }, [refreshStatus]);

  function showLimitError() {
    setError(LIMIT_MESSAGE);
    window.alert(LIMIT_MESSAGE);
  }

  async function run() {
    if (status && status.runsRemainingToday <= 0) {
      showLimitError();
      return;
    }

    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await api.scoreNow();
      setStatus(result.status);
      const processed = result.summary.postsScored + result.summary.skippedNoCandidates;
      setMessage(
        processed === 0
          ? 'No posts were waiting to be scored.'
          : `Processed ${processed} posts and added ${result.summary.signalsWritten} new signals.`,
      );
      await onScored();
    } catch (err) {
      const text = err instanceof ApiError ? err.message : 'Scoring failed. Please try again later.';
      setError(text);
      if (err instanceof ApiError && err.status === 429) window.alert(text || LIMIT_MESSAGE);
    } finally {
      setBusy(false);
      await refreshStatus();
    }
  }

  const limitReached = status !== null && status.runsRemainingToday <= 0;
  const unavailable = status === null;
  const disabled = busy || Boolean(status?.running) || status?.pendingPosts === 0 || unavailable;

  return (
    <section className="card score-card" aria-labelledby="score-now-title">
      <div>
        <h2 id="score-now-title">Update sentiment signals</h2>
        <p className="score-description">
          Score up to {status?.maxPostsPerRun ?? 60} queued posts with Gemini. Available to
          everyone and limited globally to {status?.dailyRunLimit ?? 10} runs per day.
        </p>
        <div className="score-meta" aria-live="polite">
          {status ? (
            <>
              <span>{status.pendingPosts.toLocaleString()} posts waiting</span>
              <span>
                {status.runsRemainingToday} of {status.dailyRunLimit} runs remaining today
              </span>
            </>
          ) : (
            <span>Checking scoring availability…</span>
          )}
        </div>
        {message && <p className="score-message">{message}</p>}
        {error && <p className="error" role="alert">{error}</p>}
      </div>
      <button
        className="primary score-button"
        onClick={limitReached ? showLimitError : () => void run()}
        disabled={!limitReached && disabled}
      >
        {busy
          ? 'Scoring…'
          : status?.running
            ? 'Scoring in progress…'
            : limitReached
              ? 'Daily limit reached'
              : 'Score now'}
      </button>
    </section>
  );
}

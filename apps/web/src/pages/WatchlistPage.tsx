import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, formatTime, type Role, type WatchlistEntry } from '../api.ts';

/**
 * Watchlist thresholds, admin-only on the server.
 *
 * Non-admins get the explanation rather than controls that would 403. A form
 * that renders and then fails is worse than one that says why it is absent.
 */
export function WatchlistPage({ role, onSignIn }: { role: Role | null; onSignIn: () => void }) {
  const [entries, setEntries] = useState<WatchlistEntry[]>([]);
  const [ticker, setTicker] = useState('');
  const [threshold, setThreshold] = useState('3.0');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isAdmin = role === 'admin';

  const refresh = useCallback(async () => {
    if (!isAdmin) return;
    try {
      setEntries((await api.watchlist()).watchlist);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the watchlist.');
    }
  }, [isAdmin]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function add(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await api.addWatch(ticker.toUpperCase(), Number(threshold));
      setTicker('');
      setError(null);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid columns">
      <section className="card">
        <div className="card-head">
          <h2>Watched tickers</h2>
          <span className="hint">SMS fires only on a volume + sentiment spike above the threshold</span>
        </div>

        {!isAdmin ? (
          <div className="card-body">
            <p className="empty" style={{ padding: '1.5rem 0' }}>
              <strong>{role === 'demo' ? 'Read-only account' : 'Admin sign-in required'}</strong>
              {role === 'demo'
                ? 'The demo account can read every panel but cannot change anything that spends money.'
                : 'Watchlist thresholds control an outbound SMS, so editing them is admin-only.'}
            </p>
            {role === null && (
              <div className="row" style={{ justifyContent: 'center' }}>
                <button onClick={onSignIn}>Sign in</button>
              </div>
            )}
          </div>
        ) : (
          <>
            <div className="card-body" style={{ borderBottom: '1px solid var(--border)' }}>
              <form className="row" onSubmit={add}>
                <input
                  aria-label="Ticker"
                  placeholder="NVDA"
                  value={ticker}
                  required
                  pattern="[A-Za-z]{1,5}"
                  onChange={(event) => setTicker(event.target.value)}
                  style={{ maxWidth: 110 }}
                />
                <input
                  aria-label="Alert threshold (z-score)"
                  type="number"
                  step="0.1"
                  min="0.5"
                  max="50"
                  value={threshold}
                  onChange={(event) => setThreshold(event.target.value)}
                  style={{ maxWidth: 90 }}
                />
                <button type="submit" className="primary" disabled={busy}>Add</button>
                {error && <span className="error">{error}</span>}
              </form>
            </div>

            <div className="card-body flush">
              {entries.length === 0 ? (
                <p className="empty">
                  <strong>Nothing watched yet</strong>
                  A ticker has to be on this list before any spike on it can send a message.
                </p>
              ) : (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Ticker</th>
                        <th className="num">z threshold</th>
                        <th className="num">Last alerted</th>
                        <th className="num" />
                      </tr>
                    </thead>
                    <tbody>
                      {entries.map((entry) => (
                        <tr key={entry.tickerOrTopic}>
                          <td className="sym">{entry.tickerOrTopic}</td>
                          <td className="num">{entry.alertThreshold.toFixed(1)}</td>
                          <td className="num" style={{ color: 'var(--ink-muted)' }}>
                            {entry.lastAlertedAt ? formatTime(entry.lastAlertedAt) : 'never'}
                          </td>
                          <td className="num">
                            <button
                              className="sm"
                              onClick={async () => {
                                await api.removeWatch(entry.tickerOrTopic);
                                await refresh();
                              }}
                            >
                              Remove
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Four independent spend brakes</h2>
        </div>
        <div className="card-body" style={{ fontSize: 12.5, color: 'var(--ink-secondary)', lineHeight: 1.6 }}>
          <p style={{ marginTop: 0 }}>
            <strong style={{ color: 'var(--ink)' }}>Opt-in.</strong> A ticker must be on this list.
            Nothing alerts by default.
          </p>
          <p>
            <strong style={{ color: 'var(--ink)' }}>Kind filter.</strong> Only a
            <span className="tag hot" style={{ margin: '0 0.25rem' }}>vol + sentiment</span>
            spike qualifies. A volume surge with flat sentiment is usually a scheduled news cycle.
          </p>
          <p>
            <strong style={{ color: 'var(--ink)' }}>Per-ticker cooldown.</strong> A unique
            constraint in the database, not a variable in a process — so a restart cannot resend.
          </p>
          <p style={{ marginBottom: 0 }}>
            <strong style={{ color: 'var(--ink)' }}>Rolling daily budget.</strong> A hard ceiling on
            messages per day regardless of how many spikes fire.
          </p>
        </div>
      </section>
    </div>
  );
}

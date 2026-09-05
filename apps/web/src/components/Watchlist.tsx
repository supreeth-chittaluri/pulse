import { useEffect, useState } from 'react';
import { ApiError, api, type Role, type WatchlistEntry } from '../api.ts';

/**
 * Watchlist thresholds. Admin-only on the server; this renders the read-only
 * explanation for everyone else rather than showing controls that would 403.
 */
export function Watchlist({ role }: { role: Role | null }) {
  const [entries, setEntries] = useState<WatchlistEntry[]>([]);
  const [ticker, setTicker] = useState('');
  const [threshold, setThreshold] = useState('3.0');
  const [error, setError] = useState<string | null>(null);

  const isAdmin = role === 'admin';

  async function refresh() {
    if (!isAdmin) return;
    try {
      setEntries((await api.watchlist()).watchlist);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the watchlist.');
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role]);

  if (!isAdmin) {
    return (
      <p className="empty">
        {role === 'demo'
          ? 'The demo account is read-only, so watchlist thresholds are not editable here.'
          : 'Sign in as admin to manage watchlist thresholds.'}
      </p>
    );
  }

  async function add(event: React.FormEvent) {
    event.preventDefault();
    try {
      await api.addWatch(ticker.toUpperCase(), Number(threshold));
      setTicker('');
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save.');
    }
  }

  return (
    <>
      <form className="row" onSubmit={add} style={{ marginBottom: '0.75rem' }}>
        <input
          aria-label="Ticker"
          placeholder="NVDA"
          value={ticker}
          required
          pattern="[A-Za-z]{1,5}"
          onChange={(e) => setTicker(e.target.value)}
          style={{ maxWidth: 110 }}
        />
        <input
          aria-label="Alert threshold (z-score)"
          type="number"
          step="0.1"
          min="0.5"
          max="50"
          value={threshold}
          onChange={(e) => setThreshold(e.target.value)}
          style={{ maxWidth: 90 }}
        />
        <button type="submit" className="primary">Add</button>
      </form>

      {error && <p className="error">{error}</p>}

      {entries.length === 0 ? (
        <p className="empty">Nothing watched yet. Spikes above the threshold will alert in M7.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Ticker</th>
              <th className="num">z threshold</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.tickerOrTopic} style={{ cursor: 'default' }}>
                <td style={{ fontWeight: 650 }}>{entry.tickerOrTopic}</td>
                <td className="num">{entry.alertThreshold.toFixed(1)}</td>
                <td className="num">
                  <button
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
      )}
    </>
  );
}

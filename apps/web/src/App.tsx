import { useCallback, useEffect, useState } from 'react';
import {
  api,
  setToken,
  type Role,
  type Signal,
  type Spike,
  type Stats,
  type TickerSummary,
  type TrendPoint,
} from './api.ts';
import { useStream } from './useStream.ts';
import { StatTiles } from './components/StatTiles.tsx';
import { LiveFeed } from './components/LiveFeed.tsx';
import { TickerTable } from './components/TickerTable.tsx';
import { SpikePanel } from './components/SpikePanel.tsx';
import { TrendChart } from './components/TrendChart.tsx';
import { Watchlist } from './components/Watchlist.tsx';
import { AuthDialog } from './components/AuthDialog.tsx';

const FEED_LIMIT = 60;
const TREND_RANGES = [24, 168, 720] as const;

export function App() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [spikes, setSpikes] = useState<Spike[]>([]);
  const [tickers, setTickers] = useState<TickerSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [hours, setHours] = useState<number>(168);
  const [role, setRole] = useState<Role | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refreshSummaries = useCallback(async () => {
    try {
      const [nextStats, nextTickers, nextSpikes] = await Promise.all([
        api.stats(),
        api.tickers(25),
        api.spikes(10),
      ]);
      setStats(nextStats);
      setTickers(nextTickers.tickers);
      setSpikes(nextSpikes.spikes);
      setLoadError(null);
    } catch {
      setLoadError('Could not reach the API. Is it running on port 3000?');
    }
  }, []);

  useEffect(() => {
    void refreshSummaries();
    void api
      .signals(FEED_LIMIT)
      .then((result) => setSignals(result.signals))
      .catch(() => {});
  }, [refreshSummaries]);

  useEffect(() => {
    if (!selected) {
      setTrend([]);
      return;
    }
    let cancelled = false;
    void api
      .ticker(selected, hours)
      .then((result) => {
        if (!cancelled) setTrend(result.trend);
      })
      .catch(() => {
        if (!cancelled) setTrend([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selected, hours]);

  // Live push. Signals are prepended so the newest is on top; the summary
  // panels are refreshed on a spike because a spike changes several of them at
  // once and re-querying is cheap next to getting them subtly out of sync.
  const connection = useStream({
    onSignal: useCallback((signal: Signal) => {
      setSignals((current) =>
        current.some((existing) => existing.id === signal.id)
          ? current
          : [signal, ...current].slice(0, FEED_LIMIT),
      );
    }, []),
    onSpike: useCallback(
      (spike: Spike) => {
        setSpikes((current) => [spike, ...current].slice(0, 10));
        void refreshSummaries();
      },
      [refreshSummaries],
    ),
  });

  function signOut() {
    setToken(null);
    setRole(null);
    setEmail(null);
  }

  return (
    <div className="shell">
      <header className="masthead">
        <div>
          <h1 className="wordmark">pulse</h1>
          <p className="tagline">Sentiment spikes in US equities, from retail and news chatter</p>
        </div>
        <span className="spacer" />
        <span className="status">
          <i
            className={`dot ${connection === 'live' ? 'live' : connection === 'reconnecting' ? 'down' : ''}`}
          />
          {connection === 'live' ? 'live' : connection === 'reconnecting' ? 'reconnecting' : 'connecting'}
        </span>
        {role ? (
          <span className="row" style={{ gap: '0.5rem' }}>
            <span style={{ fontSize: '0.82rem', color: 'var(--ink-secondary)' }}>
              {email} · {role}
            </span>
            <button onClick={signOut}>Sign out</button>
          </span>
        ) : (
          <button onClick={() => setAuthOpen(true)}>Sign in</button>
        )}
      </header>

      {loadError && <div className="banner warn">{loadError}</div>}

      {role === 'demo' && (
        <div className="banner">
          Signed in as <strong>demo</strong>. This account is read-only — every panel below shows
          live data, and admin actions such as editing watchlist thresholds are disabled.
        </div>
      )}

      <StatTiles stats={stats} />

      <div className="grid columns" style={{ marginTop: '1rem' }}>
        <div className="grid">
          <section className="card">
            <h2>
              {selected ? `${selected} — sentiment and volume` : 'Ticker trend'}
            </h2>
            {selected ? (
              <>
                <div className="row" style={{ marginBottom: '0.6rem' }}>
                  {TREND_RANGES.map((range) => (
                    <button
                      key={range}
                      onClick={() => setHours(range)}
                      className={hours === range ? 'primary' : ''}
                    >
                      {range === 24 ? '24h' : range === 168 ? '7d' : '30d'}
                    </button>
                  ))}
                  <span className="spacer" />
                  <button onClick={() => setSelected(null)}>Clear</button>
                </div>
                <TrendChart points={trend} hours={hours} />
              </>
            ) : (
              <p className="empty">Select a ticker below to see its trend.</p>
            )}
          </section>

          <section className="card">
            <h2>Tracked tickers</h2>
            <TickerTable tickers={tickers} selected={selected} onSelect={setSelected} />
          </section>
        </div>

        <div className="grid">
          <section className="card">
            <h2>Live feed</h2>
            <LiveFeed signals={signals} onSelect={setSelected} />
          </section>

          <section className="card">
            <h2>Spikes</h2>
            <SpikePanel spikes={spikes} onSelect={setSelected} />
          </section>

          <section className="card">
            <h2>Watchlist</h2>
            <Watchlist role={role} />
          </section>
        </div>
      </div>

      <AuthDialog
        open={authOpen}
        onClose={() => setAuthOpen(false)}
        onSignedIn={(nextRole, nextEmail) => {
          setRole(nextRole);
          setEmail(nextEmail);
        }}
      />
    </div>
  );
}

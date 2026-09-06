import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api,
  setToken,
  type Role,
  type Signal,
  type Spike,
  type Stats,
  type TickerSummary,
} from './api.ts';
import { useStream } from './useStream.ts';
import { hrefFor, useRoute, type Route } from './router.ts';
import { useScoring } from './useScoring.ts';
import { AuthDialog } from './components/AuthDialog.tsx';
import { ScoreButton } from './components/ScoreButton.tsx';
import {
  IconBack,
  IconOverview,
  IconScoring,
  IconSearch,
  IconSpikes,
  IconTickers,
  IconWatchlist,
} from './components/Icons.tsx';
import { Overview } from './pages/Overview.tsx';
import { Tickers } from './pages/Tickers.tsx';
import { TickerDetail } from './pages/TickerDetail.tsx';
import { Spikes } from './pages/Spikes.tsx';
import { Scoring } from './pages/Scoring.tsx';
import { WatchlistPage } from './pages/WatchlistPage.tsx';

const FEED_LIMIT = 60;
const TICKER_LIMIT = 100;
const SPIKE_LIMIT = 50;

const NAV = [
  { route: { name: 'overview' } as const, label: 'Overview', Icon: IconOverview },
  { route: { name: 'tickers' } as const, label: 'Tickers', Icon: IconTickers },
  { route: { name: 'spikes' } as const, label: 'Spikes', Icon: IconSpikes },
  { route: { name: 'scoring' } as const, label: 'Scoring', Icon: IconScoring },
  { route: { name: 'watchlist' } as const, label: 'Watchlist', Icon: IconWatchlist },
];

const TITLES: Record<Route['name'], { title: string; sub: string }> = {
  overview: { title: 'Overview', sub: 'Where the conversation is right now' },
  tickers: { title: 'Tickers', sub: 'Every symbol with at least one scored signal' },
  ticker: { title: 'Ticker', sub: 'Sentiment and mention volume against this symbol’s own baseline' },
  spikes: { title: 'Spikes', sub: 'Departures from a ticker’s own normal, not a global threshold' },
  scoring: { title: 'Scoring', sub: 'The pipeline from raw post to validated signal' },
  watchlist: { title: 'Watchlist', sub: 'Which tickers may send an SMS, and above what z-score' },
};

export function App() {
  const [route, navigate] = useRoute();
  const [stats, setStats] = useState<Stats | null>(null);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [spikes, setSpikes] = useState<Spike[]>([]);
  const [tickers, setTickers] = useState<TickerSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState<Role | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const refreshSummaries = useCallback(async () => {
    try {
      const [nextStats, nextTickers, nextSpikes] = await Promise.all([
        api.stats(),
        api.tickers(TICKER_LIMIT),
        api.spikes(SPIKE_LIMIT),
      ]);
      setStats(nextStats);
      setTickers(nextTickers.tickers);
      setSpikes(nextSpikes.spikes);
      setLoadError(null);
    } catch {
      setLoadError('Could not reach the API. If this is a local run, check that it is listening on port 3000.');
    }
  }, []);

  const refreshSignals = useCallback(async () => {
    const result = await api.signals(FEED_LIMIT);
    setSignals(result.signals);
  }, []);

  useEffect(() => {
    void (async () => {
      await Promise.all([refreshSummaries(), refreshSignals().catch(() => {})]);
      setLoading(false);
    })();
  }, [refreshSignals, refreshSummaries]);

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
        setSpikes((current) => [spike, ...current].slice(0, SPIKE_LIMIT));
        void refreshSummaries();
      },
      [refreshSummaries],
    ),
  });

  const scoring = useScoring(
    useCallback(async () => {
      await Promise.all([refreshSummaries(), refreshSignals()]);
    }, [refreshSignals, refreshSummaries]),
  );

  const select = useCallback(
    (symbol: string) => navigate({ name: 'ticker', symbol }),
    [navigate],
  );

  // A ticker page reached by URL may name a symbol outside the top-N summary
  // list, so the header metrics fall back to em-dashes rather than inventing
  // numbers for it.
  const selectedSummary = useMemo(
    () => (route.name === 'ticker' ? tickers.find((t) => t.tickerOrTopic === route.symbol) : undefined),
    [route, tickers],
  );

  useEffect(() => {
    const heading = route.name === 'ticker' ? route.symbol : TITLES[route.name].title;
    document.title = `${heading} · pulse`;
  }, [route]);

  function signOut() {
    setToken(null);
    setRole(null);
    setEmail(null);
  }

  function submitSearch(event: React.FormEvent) {
    event.preventDefault();
    const symbol = search.trim().toUpperCase();
    if (/^[A-Z]{1,5}$/.test(symbol)) {
      select(symbol);
      setSearch('');
    }
  }

  const header = route.name === 'ticker'
    ? { title: route.symbol, sub: TITLES.ticker.sub }
    : TITLES[route.name];

  return (
    <div className="app">
      <aside className="sidebar">
        <a className="brand" href={hrefFor({ name: 'overview' })} style={{ color: 'inherit', textDecoration: 'none' }}>
          <span className="brand-mark" aria-hidden>
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M1.5 8.5h3l2-5 3 9 2-4h3" />
            </svg>
          </span>
          <span>
            <span className="brand-name">pulse</span>
            <span className="brand-sub">sentiment spike detection</span>
          </span>
        </a>

        <nav className="nav" aria-label="Sections">
          {NAV.map(({ route: target, label, Icon }) => {
            const active = route.name === target.name || (target.name === 'tickers' && route.name === 'ticker');
            const count =
              target.name === 'tickers' ? tickers.length
              : target.name === 'spikes' ? spikes.length
              : target.name === 'scoring' ? scoring.queueSize
              : null;
            return (
              <a key={target.name} href={hrefFor(target)} aria-current={active ? 'page' : undefined}>
                <Icon />
                <span className="label">{label}</span>
                {count !== null && count > 0 && <span className="count">{count.toLocaleString()}</span>}
              </a>
            );
          })}
        </nav>

        <div className="sidebar-foot">
          <ScoreButton scoring={scoring} />
          <p className="side-note">
            Public RSS in, a free-tier model quota, free-tier hosting. Running cost is $0.
          </p>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          {route.name === 'ticker' && (
            <button className="ghost sm" onClick={() => navigate({ name: 'tickers' })} aria-label="Back to tickers">
              <IconBack />
            </button>
          )}
          <div style={{ minWidth: 0 }}>
            <h1 className="page-title">{header.title}</h1>
            <div className="page-sub">{header.sub}</div>
          </div>

          <span className="spacer" />

          <form className="search" onSubmit={submitSearch} role="search">
            <IconSearch />
            <input
              aria-label="Jump to a ticker"
              placeholder="Jump to ticker…"
              value={search}
              maxLength={5}
              onChange={(event) => setSearch(event.target.value)}
            />
          </form>

          <span
            className="status"
            title={
              connection === 'polling'
                ? 'The live stream did not prove itself within 6s, so updates are polled every 5s instead.'
                : undefined
            }
          >
            <i
              className={`dot ${
                connection === 'stream'
                  ? 'live'
                  : connection === 'polling'
                    ? 'warn'
                    : connection === 'offline'
                      ? 'down'
                      : ''
              }`}
            />
            {connection === 'stream'
              ? 'live'
              : connection === 'polling'
                ? 'polled'
                : connection === 'offline'
                  ? 'offline'
                  : 'connecting'}
          </span>

          {role ? (
            <span className="row" style={{ gap: '0.4rem' }}>
              <span className="tag">{role}</span>
              <button className="ghost sm" onClick={signOut} title={email ?? undefined}>Sign out</button>
            </span>
          ) : (
            <button className="sm" onClick={() => setAuthOpen(true)}>Sign in</button>
          )}
        </header>

        <div className="content">
          {loadError && <div className="banner bad" style={{ marginBottom: '0.9rem' }}>{loadError}</div>}

          {role === 'demo' && (
            <div className="banner" style={{ marginBottom: '0.9rem' }}>
              <span>
                Signed in as <strong>demo</strong>. Every panel shows live data; anything that
                spends money is admin-only.
              </span>
            </div>
          )}

          {route.name === 'overview' && (
            <Overview
              stats={stats}
              tickers={tickers}
              signals={signals}
              spikes={spikes}
              loading={loading}
              onSelect={select}
            />
          )}
          {route.name === 'tickers' && (
            <Tickers tickers={tickers} loading={loading} onSelect={select} />
          )}
          {route.name === 'ticker' && (
            <TickerDetail
              key={route.symbol}
              symbol={route.symbol}
              summary={selectedSummary}
              spikes={spikes}
              onSelect={select}
            />
          )}
          {route.name === 'spikes' && (
            <Spikes spikes={spikes} loading={loading} onSelect={select} />
          )}
          {route.name === 'scoring' && <Scoring scoring={scoring} />}
          {route.name === 'watchlist' && (
            <WatchlistPage role={role} onSignIn={() => setAuthOpen(true)} />
          )}
        </div>
      </main>

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

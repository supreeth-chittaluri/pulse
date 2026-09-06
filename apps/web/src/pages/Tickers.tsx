import { useMemo, useState } from 'react';
import type { TickerSummary } from '../api.ts';
import { TickerTable } from '../components/TickerTable.tsx';
import { SkeletonRows } from '../components/Skeleton.tsx';
import { IconSearch } from '../components/Icons.tsx';

export function Tickers({
  tickers,
  loading,
  onSelect,
}: {
  tickers: TickerSummary[];
  loading: boolean;
  onSelect: (ticker: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [onlyActive, setOnlyActive] = useState(false);

  const filtered = useMemo(() => {
    const needle = query.trim().toUpperCase();
    return tickers.filter((t) => {
      if (needle && !t.tickerOrTopic.includes(needle)) return false;
      if (onlyActive && t.series.reduce((a, b) => a + b, 0) === 0) return false;
      return true;
    });
  }, [tickers, query, onlyActive]);

  return (
    <section className="card">
      <div className="card-head">
        <h2>Tracked tickers</h2>
        <span className="hint">
          {loading ? 'loading…' : `${filtered.length} of ${tickers.length}`}
        </span>
        <span className="spacer" />
        <span className="seg">
          <button aria-pressed={!onlyActive} onClick={() => setOnlyActive(false)}>All</button>
          <button aria-pressed={onlyActive} onClick={() => setOnlyActive(true)}>Active 24h</button>
        </span>
        <span className="search">
          <IconSearch />
          <input
            aria-label="Filter tickers"
            placeholder="Filter symbols…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </span>
      </div>
      <div className="card-body flush">
        {loading ? (
          <SkeletonRows rows={10} cols={5} />
        ) : (
          <TickerTable
            tickers={filtered}
            onSelect={onSelect}
            emptyLabel={
              query || onlyActive ? 'No tickers match that filter.' : 'No tickers scored yet.'
            }
          />
        )}
      </div>
    </section>
  );
}

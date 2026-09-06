import { useMemo, useState } from 'react';
import type { TickerSummary } from '../api.ts';
import { timeAgo } from '../api.ts';
import { SentimentBar } from './SentimentBar.tsx';
import { Sparkline } from './Sparkline.tsx';

export type SortKey = 'tickerOrTopic' | 'mentions' | 'avgSentiment' | 'lastSeenAt' | 'vsBaseline';

type Column = { key: SortKey; label: string; numeric: boolean; compact: boolean };

const COLUMNS: Column[] = [
  { key: 'tickerOrTopic', label: 'Ticker', numeric: false, compact: true },
  { key: 'mentions', label: 'Mentions', numeric: true, compact: true },
  { key: 'vsBaseline', label: 'vs baseline', numeric: true, compact: false },
  { key: 'avgSentiment', label: 'Avg sentiment', numeric: true, compact: true },
  { key: 'lastSeenAt', label: 'Last seen', numeric: true, compact: true },
];

/**
 * Mentions relative to the ticker's own rolling hourly baseline.
 *
 * This is the column that makes the table mean anything: 40 mentions is
 * unremarkable for NVDA and extraordinary for a small cap, and only the ratio
 * against that symbol's own history says which case you are looking at.
 */
export function vsBaseline(t: TickerSummary): number | null {
  if (t.baselineAvgVolume === null || t.baselineAvgVolume <= 0) return null;
  const observedHours = Math.max(t.series.length, 1);
  return t.mentions / observedHours / t.baselineAvgVolume;
}

function compare(a: TickerSummary, b: TickerSummary, key: SortKey): number {
  switch (key) {
    case 'tickerOrTopic':
      return a.tickerOrTopic.localeCompare(b.tickerOrTopic);
    case 'mentions':
      return a.mentions - b.mentions;
    case 'avgSentiment':
      return a.avgSentiment - b.avgSentiment;
    case 'lastSeenAt':
      return new Date(a.lastSeenAt).getTime() - new Date(b.lastSeenAt).getTime();
    case 'vsBaseline':
      // Tickers with no baseline yet sort last in either direction rather than
      // masquerading as a ratio of zero.
      return (vsBaseline(a) ?? -1) - (vsBaseline(b) ?? -1);
  }
}

export function TickerTable({
  tickers,
  onSelect,
  compact = false,
  emptyLabel = 'No tickers scored yet.',
}: {
  tickers: TickerSummary[];
  onSelect: (ticker: string) => void;
  compact?: boolean;
  emptyLabel?: string;
}) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'mentions', desc: true });

  // Baselines only exist after a ticker has about a week of history, so early
  // on the column would be nothing but em-dashes. Hiding it beats rendering a
  // dead column and calling it a feature.
  const anyBaseline = tickers.some((t) => vsBaseline(t) !== null);
  const columns = COLUMNS.filter(
    (c) => (compact ? c.compact : true) && (c.key !== 'vsBaseline' || anyBaseline),
  );
  const showBaseline = columns.some((c) => c.key === 'vsBaseline');
  const rows = useMemo(() => {
    const key = columns.some((c) => c.key === sort.key) ? sort.key : 'mentions';
    const sorted = [...tickers].sort((a, b) => compare(a, b, key));
    return sort.desc ? sorted.reverse() : sorted;
  }, [tickers, sort, columns]);

  if (tickers.length === 0) return <p className="empty">{emptyLabel}</p>;

  function toggle(key: SortKey) {
    setSort((current) =>
      current.key === key ? { key, desc: !current.desc } : { key, desc: key !== 'tickerOrTopic' },
    );
  }

  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                className={`sortable${column.numeric ? ' num' : ''}`}
                onClick={() => toggle(column.key)}
                aria-sort={sort.key === column.key ? (sort.desc ? 'descending' : 'ascending') : 'none'}
              >
                {column.label}
                <span className="caret"> {sort.key === column.key ? (sort.desc ? '↓' : '↑') : ''}</span>
              </th>
            ))}
            {!compact && <th className="num">24h</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((ticker) => {
            const ratio = vsBaseline(ticker);
            return (
              <tr
                key={ticker.tickerOrTopic}
                className="clickable"
                onClick={() => onSelect(ticker.tickerOrTopic)}
              >
                <td className="sym">{ticker.tickerOrTopic}</td>
                <td className="num">{ticker.mentions.toLocaleString()}</td>
                {showBaseline && (
                  <td className="num" style={{ color: ratio && ratio >= 2 ? 'var(--critical)' : 'var(--ink-secondary)' }}>
                    {ratio === null ? <span style={{ color: 'var(--ink-muted)' }}>—</span> : `${ratio.toFixed(1)}×`}
                  </td>
                )}
                <td className="num">
                  <SentimentBar score={ticker.avgSentiment} />
                </td>
                <td className="num" style={{ color: 'var(--ink-muted)' }}>{timeAgo(ticker.lastSeenAt)}</td>
                {!compact && (
                  <td className="num">
                    <span style={{ display: 'inline-flex', justifyContent: 'flex-end', width: '100%' }}>
                      <Sparkline values={ticker.series} />
                    </span>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

import type { TickerSummary } from '../api.ts';
import { formatScore, sentimentColor, timeAgo } from '../api.ts';

/**
 * Ranked tickers. The sentiment column carries a small diverging bar as well as
 * the number: the bar makes the ranking scannable, the number makes it exact.
 */
export function TickerTable({
  tickers,
  selected,
  onSelect,
}: {
  tickers: TickerSummary[];
  selected: string | null;
  onSelect: (ticker: string) => void;
}) {
  if (tickers.length === 0) return <p className="empty">No tickers scored yet.</p>;

  return (
    <table>
      <thead>
        <tr>
          <th>Ticker</th>
          <th className="num">Mentions</th>
          <th>Avg sentiment</th>
          <th className="num">Last seen</th>
        </tr>
      </thead>
      <tbody>
        {tickers.map((ticker) => (
          <tr
            key={ticker.tickerOrTopic}
            aria-selected={selected === ticker.tickerOrTopic}
            onClick={() => onSelect(ticker.tickerOrTopic)}
          >
            <td style={{ fontWeight: 650 }}>{ticker.tickerOrTopic}</td>
            <td className="num">{ticker.mentions}</td>
            <td>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <div
                  aria-hidden
                  style={{
                    position: 'relative',
                    width: 64,
                    height: 6,
                    borderRadius: 3,
                    background: 'var(--neutral)',
                    flexShrink: 0,
                  }}
                >
                  <div
                    style={{
                      position: 'absolute',
                      left: ticker.avgSentiment >= 0 ? '50%' : `${50 + ticker.avgSentiment * 50}%`,
                      width: `${Math.abs(ticker.avgSentiment) * 50}%`,
                      top: 0,
                      height: '100%',
                      borderRadius: 3,
                      background: sentimentColor(ticker.avgSentiment),
                    }}
                  />
                </div>
                <span style={{ color: sentimentColor(ticker.avgSentiment), fontWeight: 600 }}>
                  {formatScore(ticker.avgSentiment)}
                </span>
              </div>
            </td>
            <td className="num" style={{ color: 'var(--ink-muted)' }}>{timeAgo(ticker.lastSeenAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

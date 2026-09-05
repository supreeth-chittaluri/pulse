import type { Signal } from '../api.ts';
import { formatScore, polarity, sentimentColor, timeAgo } from '../api.ts';

/**
 * Newest scored signals, prepended as they arrive over SSE.
 *
 * Each row prints the signed score next to the coloured chip, so polarity is
 * never communicated by hue alone.
 */
export function LiveFeed({ signals, onSelect }: { signals: Signal[]; onSelect: (t: string) => void }) {
  if (signals.length === 0) {
    return <p className="empty">Waiting for signals. Run <code>npm run worker -- score-once</code>.</p>;
  }

  return (
    <ul className="feed">
      {signals.map((signal) => (
        <li key={signal.id}>
          <span
            className="chip"
            style={{
              background: `color-mix(in srgb, ${sentimentColor(signal.sentimentScore)} 16%, transparent)`,
              color: sentimentColor(signal.sentimentScore),
            }}
            title={`${polarity(signal.sentimentScore)} ${formatScore(signal.sentimentScore)}`}
          >
            <button
              onClick={() => onSelect(signal.tickerOrTopic)}
              style={{ all: 'unset', cursor: 'pointer', fontWeight: 700 }}
            >
              {signal.tickerOrTopic}
            </button>
            {formatScore(signal.sentimentScore)}
          </span>
          <div>
            <div className="feed-title">
              <a href={signal.url} target="_blank" rel="noreferrer noopener">
                {signal.title.length > 110 ? `${signal.title.slice(0, 110)}…` : signal.title}
              </a>
            </div>
            <div className="feed-meta">
              {signal.source} · {timeAgo(signal.scrapedAt)}
              {signal.confidence !== null && ` · confidence ${signal.confidence.toFixed(2)}`}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

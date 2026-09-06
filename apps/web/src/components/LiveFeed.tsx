import type { Signal } from '../api.ts';
import { formatScore, polarity, sentimentColor, sentimentTint, timeAgo } from '../api.ts';
import { IconExternal } from './Icons.tsx';

/**
 * Newest scored signals, prepended as they arrive over SSE.
 *
 * Each row prints the signed score next to the coloured chip, so polarity is
 * never communicated by hue alone.
 */
export function LiveFeed({
  signals,
  onSelect,
  maxHeight = 520,
  emptyHint,
}: {
  signals: Signal[];
  onSelect: (ticker: string) => void;
  maxHeight?: number;
  emptyHint?: string;
}) {
  if (signals.length === 0) {
    return (
      <p className="empty">
        <strong>No signals yet</strong>
        {emptyHint ?? 'Ingested posts are scored automatically; Scoring can run a pass on demand.'}
      </p>
    );
  }

  return (
    <ul className="feed" style={{ maxHeight }}>
      {signals.map((signal) => (
        <li key={signal.id}>
          <span
            className="chip"
            style={{
              background: sentimentTint(signal.sentimentScore, 15),
              color: sentimentColor(signal.sentimentScore),
              alignSelf: 'flex-start',
            }}
            title={`${polarity(signal.sentimentScore)} ${formatScore(signal.sentimentScore)}`}
          >
            <button
              className="link"
              style={{ color: 'inherit', fontWeight: 700 }}
              onClick={() => onSelect(signal.tickerOrTopic)}
            >
              {signal.tickerOrTopic}
            </button>
            {formatScore(signal.sentimentScore)}
          </span>
          <div style={{ minWidth: 0 }}>
            <div className="feed-title">
              <a href={signal.url} target="_blank" rel="noreferrer noopener">
                {signal.title.length > 120 ? `${signal.title.slice(0, 120)}…` : signal.title}{' '}
                <IconExternal />
              </a>
            </div>
            <div className="feed-meta">
              <span className="tag">{signal.source}</span>
              <span>posted {timeAgo(signal.observedAt)}</span>
              {signal.confidence !== null && <span>confidence {signal.confidence.toFixed(2)}</span>}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

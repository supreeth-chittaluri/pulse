import type { Spike } from '../api.ts';
import { formatScore, sentimentColor, timeAgo } from '../api.ts';

/**
 * Detected spikes. `volume+sentiment` is called out because it is the only kind
 * that can trigger an SMS -- a volume surge with flat sentiment is usually just
 * a scheduled news cycle, and alerting on those is how a channel gets muted.
 */
export function SpikePanel({
  spikes,
  onSelect,
  maxHeight = 320,
}: {
  spikes: Spike[];
  onSelect: (ticker: string) => void;
  maxHeight?: number;
}) {
  if (spikes.length === 0) {
    return (
      <p className="empty">
        <strong>No spikes yet</strong>
        Detection needs roughly a week of history per ticker before a baseline exists.
      </p>
    );
  }

  return (
    <ul className="feed" style={{ maxHeight }}>
      {spikes.map((spike) => (
        <li key={`${spike.tickerOrTopic}-${spike.detectedAt}`}>
          <span
            className="chip"
            style={{
              background: 'color-mix(in srgb, var(--critical) 14%, transparent)',
              color: 'var(--critical)',
              alignSelf: 'flex-start',
            }}
          >
            <button
              className="link"
              style={{ color: 'inherit', fontWeight: 700 }}
              onClick={() => onSelect(spike.tickerOrTopic)}
            >
              {spike.tickerOrTopic}
            </button>
            z{spike.volumeZ.toFixed(1)}
          </span>
          <div style={{ minWidth: 0 }}>
            <div className="feed-title">
              <strong className="num" style={{ fontWeight: 620 }}>{spike.mentionCount}</strong> mentions
              against a {spike.baselineAvgVolume.toFixed(1)}/hr baseline
              {spike.kind === 'volume+sentiment' && spike.currentSentiment !== null && (
                <>
                  {' · '}
                  <span style={{ color: sentimentColor(spike.currentSentiment), fontWeight: 620 }}>
                    {formatScore(spike.currentSentiment)}
                  </span>
                </>
              )}
            </div>
            <div className="feed-meta">
              <span className={`tag${spike.kind === 'volume+sentiment' ? ' hot' : ''}`}>
                {spike.kind === 'volume+sentiment' ? 'volume + sentiment' : 'volume only'}
              </span>
              <span>{timeAgo(spike.detectedAt)}</span>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

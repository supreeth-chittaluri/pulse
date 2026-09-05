import type { Spike } from '../api.ts';
import { formatScore, timeAgo } from '../api.ts';

/**
 * Detected spikes. `volume+sentiment` is called out because it is the only kind
 * that will trigger an SMS in M7 -- a volume surge with flat sentiment is
 * usually just a news cycle.
 */
export function SpikePanel({ spikes, onSelect }: { spikes: Spike[]; onSelect: (t: string) => void }) {
  if (spikes.length === 0) {
    return (
      <p className="empty">
        No spikes yet. Detection needs about a week of history per ticker before a
        baseline exists.
      </p>
    );
  }

  return (
    <ul className="feed">
      {spikes.map((spike) => (
        <li key={`${spike.tickerOrTopic}-${spike.detectedAt}`}>
          <span
            className="chip"
            style={{
              background: 'color-mix(in srgb, var(--critical) 16%, transparent)',
              color: 'var(--critical)',
            }}
          >
            <button
              onClick={() => onSelect(spike.tickerOrTopic)}
              style={{ all: 'unset', cursor: 'pointer', fontWeight: 700 }}
            >
              {spike.tickerOrTopic}
            </button>
            z{spike.volumeZ.toFixed(1)}
          </span>
          <div>
            <div className="feed-title">
              {spike.mentionCount} mentions vs a {spike.baselineAvgVolume.toFixed(1)}/hr baseline
              {spike.kind === 'volume+sentiment' && spike.currentSentiment !== null && (
                <> · sentiment {formatScore(spike.currentSentiment)}</>
              )}
            </div>
            <div className="feed-meta">
              {spike.kind === 'volume+sentiment' ? 'volume + sentiment' : 'volume only'} ·{' '}
              {timeAgo(spike.detectedAt)}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

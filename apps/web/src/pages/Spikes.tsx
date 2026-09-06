import { useMemo, useState } from 'react';
import type { Spike } from '../api.ts';
import { formatScore, formatTime, sentimentColor, timeAgo } from '../api.ts';
import { SkeletonRows } from '../components/Skeleton.tsx';

type Filter = 'all' | 'volume+sentiment';

export function Spikes({
  spikes,
  loading,
  onSelect,
}: {
  spikes: Spike[];
  loading: boolean;
  onSelect: (ticker: string) => void;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const rows = useMemo(
    () => (filter === 'all' ? spikes : spikes.filter((s) => s.kind === 'volume+sentiment')),
    [spikes, filter],
  );

  return (
    <section className="card">
      <div className="card-head">
        <h2>Detected spikes</h2>
        <span className="hint">{loading ? 'loading…' : `${rows.length} shown`}</span>
        <span className="spacer" />
        <span className="seg">
          <button aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>All</button>
          <button aria-pressed={filter === 'volume+sentiment'} onClick={() => setFilter('volume+sentiment')}>
            Alertable
          </button>
        </span>
      </div>

      <div className="card-body flush">
        {loading ? (
          <SkeletonRows rows={8} cols={5} />
        ) : rows.length === 0 ? (
          <p className="empty">
            <strong>{filter === 'all' ? 'No spikes yet' : 'No alertable spikes'}</strong>
            {filter === 'all'
              ? 'Detection needs roughly a week of history per ticker before a baseline exists.'
              : 'Only a volume surge that also moves sentiment is worth an SMS.'}
          </p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Ticker</th>
                  <th className="num">Mentions</th>
                  <th className="num">Baseline</th>
                  <th className="num">Volume z</th>
                  <th className="num">Sentiment z</th>
                  <th className="num">Sentiment</th>
                  <th>Kind</th>
                  <th className="num">Detected</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((spike) => (
                  <tr
                    key={`${spike.tickerOrTopic}-${spike.detectedAt}`}
                    className="clickable"
                    onClick={() => onSelect(spike.tickerOrTopic)}
                  >
                    <td className="sym">{spike.tickerOrTopic}</td>
                    <td className="num">{spike.mentionCount}</td>
                    <td className="num" style={{ color: 'var(--ink-muted)' }}>
                      {spike.baselineAvgVolume.toFixed(1)}/hr
                    </td>
                    <td className="num" style={{ fontWeight: 620 }}>{spike.volumeZ.toFixed(2)}</td>
                    <td className="num">
                      {spike.sentimentZ === null ? (
                        <span style={{ color: 'var(--ink-muted)' }}>—</span>
                      ) : (
                        spike.sentimentZ.toFixed(2)
                      )}
                    </td>
                    <td className="num">
                      {spike.currentSentiment === null ? (
                        <span style={{ color: 'var(--ink-muted)' }}>—</span>
                      ) : (
                        <span style={{ color: sentimentColor(spike.currentSentiment), fontWeight: 620 }}>
                          {formatScore(spike.currentSentiment)}
                        </span>
                      )}
                    </td>
                    <td>
                      <span className={`tag${spike.kind === 'volume+sentiment' ? ' hot' : ''}`}>
                        {spike.kind === 'volume+sentiment' ? 'vol + sentiment' : 'volume only'}
                      </span>
                    </td>
                    <td className="num" style={{ color: 'var(--ink-muted)' }} title={formatTime(spike.detectedAt)}>
                      {timeAgo(spike.detectedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

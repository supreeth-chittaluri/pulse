import type { Stats } from '../api.ts';
import { timeAgo } from '../api.ts';
import { Skeleton } from './Skeleton.tsx';

/**
 * Headline counts. Deliberately not a chart -- four unrelated scalars have no
 * shared scale, so a bar chart of them would invite comparisons that mean
 * nothing. A number is the right form for a number.
 */
export function StatTiles({ stats }: { stats: Stats | null }) {
  const tiles = [
    {
      label: 'Posts ingested',
      value: stats?.posts,
      note: stats?.lastIngestAt ? `last ${timeAgo(stats.lastIngestAt)}` : 'no ingest yet',
    },
    {
      label: 'Signals scored',
      value: stats?.signals,
      note: stats?.lastSignalAt ? `last ${timeAgo(stats.lastSignalAt)}` : 'nothing scored yet',
    },
    { label: 'Tickers tracked', value: stats?.tickers, note: 'with at least one signal' },
    { label: 'Spikes detected', value: stats?.spikes, note: 'above the z threshold' },
  ];

  return (
    <div className="grid tiles">
      {tiles.map((tile) => (
        <div className="card tile" key={tile.label}>
          <div className="tile-label">{tile.label}</div>
          {tile.value === undefined ? (
            <div style={{ padding: '0.45rem 0 0.5rem' }}>
              <Skeleton width={68} height={22} />
            </div>
          ) : (
            <div className="tile-value">{tile.value.toLocaleString()}</div>
          )}
          <div className="tile-note">{tile.note}</div>
        </div>
      ))}
    </div>
  );
}

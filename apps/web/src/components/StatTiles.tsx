import type { Stats } from '../api.ts';
import { timeAgo } from '../api.ts';

/**
 * Headline counts. Deliberately not a chart -- four unrelated scalars have no
 * shared scale, so a bar chart of them would invite comparisons that mean
 * nothing. A number is the right form for a number.
 */
export function StatTiles({ stats }: { stats: Stats | null }) {
  const tiles = [
    { label: 'Posts ingested', value: stats?.posts, note: stats?.lastIngestAt ? `last ${timeAgo(stats.lastIngestAt)}` : null },
    { label: 'Signals scored', value: stats?.signals, note: stats?.lastSignalAt ? `last ${timeAgo(stats.lastSignalAt)}` : null },
    { label: 'Tickers tracked', value: stats?.tickers, note: null },
    { label: 'Spikes detected', value: stats?.spikes, note: null },
  ];

  return (
    <div className="grid tiles">
      {tiles.map((tile) => (
        <div className="card" key={tile.label}>
          <div className="tile-label">{tile.label}</div>
          <div className="tile-value">
            {tile.value === undefined ? '—' : tile.value.toLocaleString()}
          </div>
          {tile.note && <div className="tile-note">{tile.note}</div>}
        </div>
      ))}
    </div>
  );
}

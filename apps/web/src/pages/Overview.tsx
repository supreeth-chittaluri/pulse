import type { Signal, Spike, Stats, TickerSummary } from '../api.ts';
import { StatTiles } from '../components/StatTiles.tsx';
import { TickerTable } from '../components/TickerTable.tsx';
import { LiveFeed } from '../components/LiveFeed.tsx';
import { SpikePanel } from '../components/SpikePanel.tsx';
import { SkeletonRows } from '../components/Skeleton.tsx';
import { hrefFor } from '../router.ts';

export function Overview({
  stats,
  tickers,
  signals,
  spikes,
  loading,
  onSelect,
}: {
  stats: Stats | null;
  tickers: TickerSummary[];
  signals: Signal[];
  spikes: Spike[];
  loading: boolean;
  onSelect: (ticker: string) => void;
}) {
  return (
    <>
      <StatTiles stats={stats} />

      <div className="grid columns" style={{ marginTop: '0.9rem' }}>
        <div className="grid">
          <section className="card">
            <div className="card-head">
              <h2>Most discussed</h2>
              <span className="hint">last 7 days</span>
              <span className="spacer" />
              <a href={hrefFor({ name: 'tickers' })}>All tickers →</a>
            </div>
            <div className="card-body flush">
              {loading ? (
                <SkeletonRows rows={6} cols={4} />
              ) : (
                <TickerTable tickers={tickers.slice(0, 8)} onSelect={onSelect} compact />
              )}
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h2>Recent spikes</h2>
              <span className="hint">departures from each ticker&apos;s own baseline</span>
              <span className="spacer" />
              <a href={hrefFor({ name: 'spikes' })}>All spikes →</a>
            </div>
            <div className="card-body flush">
              {loading ? <SkeletonRows rows={3} cols={3} /> : <SpikePanel spikes={spikes.slice(0, 5)} onSelect={onSelect} />}
            </div>
          </section>
        </div>

        <section className="card">
          <div className="card-head">
            <h2>Live signals</h2>
            <span className="hint">newest first</span>
          </div>
          <div className="card-body flush">
            {loading && signals.length === 0 ? (
              <SkeletonRows rows={7} cols={2} />
            ) : (
              <LiveFeed signals={signals} onSelect={onSelect} maxHeight={620} />
            )}
          </div>
        </section>
      </div>
    </>
  );
}

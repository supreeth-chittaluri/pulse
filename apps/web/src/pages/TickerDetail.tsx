import { useEffect, useState } from 'react';
import {
  api,
  ApiError,
  formatScore,
  sentimentColor,
  timeAgo,
  type Signal,
  type Spike,
  type TickerSummary,
  type TrendPoint,
} from '../api.ts';
import { TrendChart } from '../components/TrendChart.tsx';
import { LiveFeed } from '../components/LiveFeed.tsx';
import { SpikePanel } from '../components/SpikePanel.tsx';
import { Skeleton } from '../components/Skeleton.tsx';

const RANGES = [
  { hours: 24, label: '24h' },
  { hours: 168, label: '7d' },
  { hours: 720, label: '30d' },
] as const;

export function TickerDetail({
  symbol,
  summary,
  spikes,
  onSelect,
}: {
  symbol: string;
  summary: TickerSummary | undefined;
  spikes: Spike[];
  onSelect: (ticker: string) => void;
}) {
  const [hours, setHours] = useState<number>(168);
  const [trend, setTrend] = useState<TrendPoint[] | null>(null);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setTrend(null);
    setError(null);
    void api
      .ticker(symbol, hours)
      .then((result) => {
        if (cancelled) return;
        setTrend(result.trend);
        setSignals(result.signals);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setTrend([]);
        setSignals([]);
        setError(
          err instanceof ApiError && err.status === 404
            ? `No signals have been recorded for ${symbol}.`
            : 'Could not load this ticker.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, hours]);

  const windowMentions = trend?.reduce((total, point) => total + point.mentions, 0) ?? null;
  const tickerSpikes = spikes.filter((spike) => spike.tickerOrTopic === symbol);

  return (
    <>
      <div className="detail-head">
        <div>
          <div className="detail-sym">{symbol}</div>
          <div style={{ fontSize: 11.5, color: 'var(--ink-muted)' }}>
            {summary ? `last mention ${timeAgo(summary.lastSeenAt)}` : 'not in the current top tickers'}
          </div>
        </div>

        <div className="detail-metrics">
          <div>
            <div className="metric-label">Mentions in window</div>
            <div className="metric-value">
              {windowMentions === null ? <Skeleton width={44} height={17} /> : windowMentions.toLocaleString()}
            </div>
          </div>
          <div>
            <div className="metric-label">Avg sentiment</div>
            <div className="metric-value" style={{ color: summary ? sentimentColor(summary.avgSentiment) : undefined }}>
              {summary ? formatScore(summary.avgSentiment) : '—'}
            </div>
          </div>
          <div>
            <div className="metric-label">Baseline volume</div>
            <div className="metric-value">
              {summary?.baselineAvgVolume != null ? `${summary.baselineAvgVolume.toFixed(1)}/hr` : '—'}
            </div>
          </div>
          <div>
            <div className="metric-label">Baseline sentiment</div>
            <div className="metric-value">
              {summary?.baselineAvgSentiment != null ? formatScore(summary.baselineAvgSentiment) : '—'}
            </div>
          </div>
        </div>

        <span className="spacer" />
        <span className="seg">
          {RANGES.map((range) => (
            <button
              key={range.hours}
              aria-pressed={hours === range.hours}
              onClick={() => setHours(range.hours)}
            >
              {range.label}
            </button>
          ))}
        </span>
      </div>

      {error && <div className="banner warn" style={{ marginBottom: '0.9rem' }}>{error}</div>}

      <section className="card">
        <div className="card-head">
          <h2>Sentiment and mention volume</h2>
          <span className="hint">stacked axes — never a dual-axis chart</span>
        </div>
        <div className="card-body">
          {trend === null ? (
            <Skeleton height={260} />
          ) : (
            <TrendChart points={trend} hours={hours} />
          )}
        </div>
      </section>

      <div className="grid columns" style={{ marginTop: '0.9rem' }}>
        <section className="card">
          <div className="card-head">
            <h2>Signals mentioning {symbol}</h2>
            <span className="hint">most recent 25</span>
          </div>
          <div className="card-body flush">
            <LiveFeed
              signals={signals}
              onSelect={onSelect}
              maxHeight={520}
              emptyHint={`Nothing scored for ${symbol} yet.`}
            />
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <h2>Spikes for {symbol}</h2>
          </div>
          <div className="card-body flush">
            <SpikePanel spikes={tickerSpikes} onSelect={onSelect} maxHeight={520} />
          </div>
        </section>
      </div>
    </>
  );
}

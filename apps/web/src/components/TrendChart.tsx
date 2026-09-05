import { useEffect, useMemo, useRef, useState } from 'react';
import type { TrendPoint } from '../api.ts';
import { formatScore } from '../api.ts';

/**
 * Sentiment and mention volume over time.
 *
 * Two stacked plots sharing one x-axis, never a dual y-axis. They are different
 * measures on different scales, and overlaying them on two y-scales lets the
 * author manufacture whatever crossing point flatters the story -- the single
 * most common way a chart lies.
 *
 * Sentiment is diverging around zero, so the area is split at the zero line:
 * blue above, red below, with the zero baseline drawn heavier than the grid.
 * The line itself stays ink-coloured; the fill carries polarity and the tooltip
 * prints the signed number, so hue never carries meaning alone.
 */
export function TrendChart({ points, hours }: { points: TrendPoint[]; hours: number }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const element = wrapRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(280, entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const layout = useMemo(() => {
    const padding = { left: 38, right: 12, top: 10, bottom: 20 };
    const sentimentHeight = 122;
    const gap = 26;
    const volumeHeight = 62;
    const height = padding.top + sentimentHeight + gap + volumeHeight + padding.bottom;
    return { padding, sentimentHeight, gap, volumeHeight, height };
  }, []);

  const { padding, sentimentHeight, gap, volumeHeight, height } = layout;
  const plotWidth = Math.max(1, width - padding.left - padding.right);

  const sorted = useMemo(
    () => [...points].sort((a, b) => new Date(a.bucket).getTime() - new Date(b.bucket).getTime()),
    [points],
  );

  if (sorted.length === 0) {
    return <p className="empty">No activity in the selected window.</p>;
  }

  const times = sorted.map((p) => new Date(p.bucket).getTime());
  const firstTime = times[0]!;
  const lastTime = times[times.length - 1]!;

  // A domain of zero width (every point in one bucket, which is exactly what a
  // backfill run produces) would put the mark on the axis and divide by zero.
  // Pad it to an hour either side so a lone point sits in the middle.
  const HOUR = 3_600_000;
  const degenerate = lastTime - firstTime < HOUR;
  const minTime = degenerate ? firstTime - HOUR : firstTime;
  const maxTime = degenerate ? lastTime + HOUR : lastTime;
  const span = Math.max(1, maxTime - minTime);
  const maxMentions = Math.max(1, ...sorted.map((p) => p.mentions));

  const x = (time: number) => padding.left + ((time - minTime) / span) * plotWidth;
  // Sentiment is fixed to the full -1..1 range rather than auto-scaled: a
  // rescaled axis makes a trivial wobble look like a crisis.
  const ySentiment = (value: number) =>
    padding.top + ((1 - value) / 2) * sentimentHeight;
  const zeroY = ySentiment(0);
  const volumeTop = padding.top + sentimentHeight + gap;
  const yVolume = (count: number) => volumeTop + volumeHeight - (count / maxMentions) * volumeHeight;

  const linePath = sorted
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(times[i]!).toFixed(2)},${ySentiment(p.avgSentiment).toFixed(2)}`)
    .join(' ');

  const areaPath =
    `${linePath} L${x(maxTime).toFixed(2)},${zeroY.toFixed(2)} L${x(minTime).toFixed(2)},${zeroY.toFixed(2)} Z`;

  const barWidth = Math.max(1.5, Math.min(14, (plotWidth / Math.max(1, sorted.length)) - 2));
  // `?? null` matters: with noUncheckedIndexedAccess an index read is
  // `T | undefined`, and a bare undefined would slip past the `!== null` guards
  // below.
  const active = hover === null ? null : (sorted[hover] ?? null);
  const activeTime = hover === null ? null : (times[hover] ?? null);

  function onMove(event: React.MouseEvent<SVGSVGElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - box.left;
    let nearest = 0;
    let best = Infinity;
    for (let i = 0; i < times.length; i += 1) {
      const distance = Math.abs(x(times[i]!) - px);
      if (distance < best) {
        best = distance;
        nearest = i;
      }
    }
    setHover(nearest);
  }

  const tickCount = Math.min(5, sorted.length);
  const ticks = Array.from({ length: tickCount }, (_, i) => {
    const time = minTime + (span * i) / Math.max(1, tickCount - 1);
    return { time, label: formatTick(time, hours) };
  });

  return (
    <div className="chart-wrap" ref={wrapRef}>
      <div className="legend" style={{ marginBottom: '0.4rem' }}>
        <span>
          <i className="swatch" style={{ background: 'var(--bullish)' }} /> bullish
        </span>
        <span>
          <i className="swatch" style={{ background: 'var(--bearish)' }} /> bearish
        </span>
        <span>
          <i className="swatch" style={{ background: 'var(--series)' }} /> mentions / hour
        </span>
      </div>

      <svg
        width={width}
        height={height}
        role="img"
        aria-label={`Sentiment and mention volume over the last ${hours} hours`}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        style={{ display: 'block', touchAction: 'none' }}
      >
        <defs>
          <clipPath id="above-zero">
            <rect x={padding.left} y={padding.top} width={plotWidth} height={zeroY - padding.top} />
          </clipPath>
          <clipPath id="below-zero">
            <rect
              x={padding.left}
              y={zeroY}
              width={plotWidth}
              height={padding.top + sentimentHeight - zeroY}
            />
          </clipPath>
        </defs>

        {/* sentiment gridlines, recessive */}
        {[1, 0.5, -0.5, -1].map((value) => (
          <line
            key={value}
            x1={padding.left}
            x2={padding.left + plotWidth}
            y1={ySentiment(value)}
            y2={ySentiment(value)}
            stroke="var(--grid)"
            strokeWidth={1}
          />
        ))}
        {[1, 0, -1].map((value) => (
          <text
            key={`label-${value}`}
            x={padding.left - 7}
            y={ySentiment(value) + 3.5}
            textAnchor="end"
            fontSize={10}
            fill="var(--ink-muted)"
          >
            {value > 0 ? `+${value}` : value}
          </text>
        ))}

        <path d={areaPath} fill="var(--bullish)" opacity={0.16} clipPath="url(#above-zero)" />
        <path d={areaPath} fill="var(--bearish)" opacity={0.16} clipPath="url(#below-zero)" />

        {/* zero baseline: heavier than the grid, because it is the thing sign is read against */}
        <line
          x1={padding.left}
          x2={padding.left + plotWidth}
          y1={zeroY}
          y2={zeroY}
          stroke="var(--axis)"
          strokeWidth={1.5}
        />

        <path d={linePath} fill="none" stroke="var(--ink-secondary)" strokeWidth={2}
              strokeLinejoin="round" strokeLinecap="round" />

        {/* Point markers on sparse series. A single-point series draws no line
            at all, so without these one hour of data renders as nothing. */}
        {sorted.length <= 40 &&
          sorted.map((point, i) => (
            <circle
              key={`pt-${point.bucket}`}
              cx={x(times[i]!)}
              cy={ySentiment(point.avgSentiment)}
              r={4}
              fill={
                point.avgSentiment > 0.2
                  ? 'var(--bullish)'
                  : point.avgSentiment < -0.2
                    ? 'var(--bearish)'
                    : 'var(--ink-muted)'
              }
              stroke="var(--surface)"
              strokeWidth={1.5}
            />
          ))}

        {/* volume bars: 4px rounded ends, anchored to their own baseline */}
        {sorted.map((point, i) => {
          const barHeight = Math.max(1, volumeTop + volumeHeight - yVolume(point.mentions));
          return (
            <rect
              key={point.bucket}
              x={Math.min(
                Math.max(x(times[i]!) - barWidth / 2, padding.left),
                padding.left + plotWidth - barWidth,
              )}
              y={yVolume(point.mentions)}
              width={barWidth}
              height={barHeight}
              rx={Math.min(4, barWidth / 2)}
              fill="var(--series)"
              opacity={hover === null || hover === i ? 0.9 : 0.45}
            />
          );
        })}
        <line
          x1={padding.left}
          x2={padding.left + plotWidth}
          y1={volumeTop + volumeHeight}
          y2={volumeTop + volumeHeight}
          stroke="var(--axis)"
          strokeWidth={1}
        />
        <text x={padding.left - 7} y={volumeTop + 8} textAnchor="end" fontSize={10} fill="var(--ink-muted)">
          {maxMentions}
        </text>

        {ticks.map((tick) => (
          <text
            key={tick.time}
            x={x(tick.time)}
            y={height - 6}
            textAnchor="middle"
            fontSize={10}
            fill="var(--ink-muted)"
          >
            {tick.label}
          </text>
        ))}

        {activeTime !== null && (
          <>
            <line
              x1={x(activeTime)}
              x2={x(activeTime)}
              y1={padding.top}
              y2={volumeTop + volumeHeight}
              stroke="var(--ink-muted)"
              strokeWidth={1}
              strokeDasharray="3 3"
            />
            <circle
              cx={x(activeTime)}
              cy={ySentiment(active!.avgSentiment)}
              r={4.5}
              fill="var(--surface)"
              stroke={
                active!.avgSentiment > 0.2
                  ? 'var(--bullish)'
                  : active!.avgSentiment < -0.2
                    ? 'var(--bearish)'
                    : 'var(--ink-muted)'
              }
              strokeWidth={2}
            />
          </>
        )}
      </svg>

      {active && activeTime !== null && (
        <div
          className="tooltip"
          style={{
            left: Math.min(Math.max(8, x(activeTime) + 10), width - 150),
            top: padding.top,
          }}
        >
          <div style={{ color: 'var(--ink-secondary)' }}>
            {new Date(activeTime).toLocaleString(undefined, {
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
            })}
          </div>
          <div>
            <strong>{formatScore(active.avgSentiment)}</strong> sentiment
          </div>
          <div>
            {active.mentions} mention{active.mentions === 1 ? '' : 's'}
          </div>
        </div>
      )}
    </div>
  );
}

function formatTick(time: number, hours: number): string {
  const date = new Date(time);
  if (hours <= 48) {
    return date.toLocaleTimeString(undefined, { hour: 'numeric' });
  }
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

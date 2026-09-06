/**
 * 24 hourly mention counts, drawn small enough to sit inside a table row.
 *
 * There is no axis and no tick labels on purpose: the shape is the message
 * ("quiet, then a burst"), and the exact numbers live in the columns beside it.
 * A sparkline that tries to be a chart just makes the row taller.
 */
export function Sparkline({
  values,
  width = 76,
  height = 22,
  color = 'var(--series)',
}: {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
}) {
  if (values.length < 2) {
    return <svg className="spark" width={width} height={height} aria-hidden />;
  }

  const max = Math.max(...values, 1);
  const step = width / (values.length - 1);
  const y = (v: number) => height - 1.5 - (v / max) * (height - 3);
  const line = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${line} L${width},${height} L0,${height} Z`;
  const last = values[values.length - 1]!;
  const total = values.reduce((a, b) => a + b, 0);

  return (
    <svg
      className="spark"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`${total} mentions over the last ${values.length} hours, peaking at ${max} in an hour`}
    >
      <path d={area} fill={color} opacity={0.12} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.25} strokeLinejoin="round" />
      {last > 0 && <circle cx={width} cy={y(last)} r={1.8} fill={color} />}
    </svg>
  );
}

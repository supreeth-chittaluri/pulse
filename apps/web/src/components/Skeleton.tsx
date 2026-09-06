/** Placeholder blocks so a slow first load has structure instead of a blank page. */
export function Skeleton({ width = '100%', height = 14 }: { width?: number | string; height?: number }) {
  return <div className="skel" style={{ width, height }} aria-hidden />;
}

export function SkeletonRows({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div style={{ padding: '0.9rem', display: 'grid', gap: '0.65rem' }} aria-busy>
      <span className="visually-hidden">Loading…</span>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} style={{ display: 'flex', gap: '0.9rem', alignItems: 'center' }}>
          {Array.from({ length: cols }, (_, c) => (
            <Skeleton key={c} width={c === 0 ? 52 : `${100 / cols}%`} height={12} />
          ))}
        </div>
      ))}
    </div>
  );
}

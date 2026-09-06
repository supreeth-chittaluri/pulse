import type { Scoring } from '../useScoring.ts';
import { hrefFor } from '../router.ts';

/** The compact sidebar control. The full breakdown lives on the Scoring page. */
export function ScoreButton({ scoring }: { scoring: Scoring }) {
  const { status, disabled, label, run } = scoring;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
      <button className="primary" disabled={disabled} onClick={() => void run()} style={{ justifyContent: 'center' }}>
        {label}
      </button>
      <a className="side-note" href={hrefFor({ name: 'scoring' })} style={{ color: 'var(--ink-muted)' }}>
        {status
          ? `${scoring.queueSize.toLocaleString()} posts queued · ${status.runsRemainingToday}/${status.dailyRunLimit} runs left today`
          : scoring.unavailable
            ? 'The scoring endpoint is not responding.'
            : 'Checking scoring availability…'}
      </a>
    </div>
  );
}

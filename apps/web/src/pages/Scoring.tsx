import { timeAgo } from '../api.ts';
import type { Scoring as ScoringState } from '../useScoring.ts';
import { Skeleton } from '../components/Skeleton.tsx';

/**
 * The pipeline page.
 *
 * "Score now" is public, which normally would be reckless -- it spends a paid
 * quota. It is safe here only because of the numbers on this page: a global
 * daily run cap, a global daily provider-request budget, and a single-flight
 * lock. Showing all three is the point; a button that quietly spends money is
 * exactly what the audit test exists to prevent.
 */
export function Scoring({ scoring }: { scoring: ScoringState }) {
  const { status, busy, message, error, disabled, label, run, queueSize } = scoring;

  const runsUsed = status ? status.dailyRunLimit - status.runsRemainingToday : 0;
  const runPercent = status ? (runsUsed / Math.max(status.dailyRunLimit, 1)) * 100 : 0;
  const requestPercent = status
    ? (status.requestsUsedToday / Math.max(status.dailyRequestBudget, 1)) * 100
    : 0;

  return (
    <div className="grid columns">
      <div className="grid">
        <section className="card">
          <div className="card-head">
            <h2>Scoring queue</h2>
            <span className="hint">posts waiting on each stage</span>
            <span className="spacer" />
            <button className="primary" disabled={disabled} onClick={() => void run()}>
              {label}
            </button>
          </div>
          <div className="card-body">
            {status === null ? (
              <Skeleton height={90} />
            ) : (
              <>
                <div className="score-grid">
                  <div className="score-stat">
                    <div className="k">Awaiting ticker filter</div>
                    <div className="v">{status.triagePendingPosts.toLocaleString()}</div>
                  </div>
                  <div className="score-stat">
                    <div className="k">Awaiting Gemini</div>
                    <div className="v">{status.pendingPosts.toLocaleString()}</div>
                  </div>
                  <div className="score-stat">
                    <div className="k">Given up on</div>
                    <div className="v">{status.failedPosts.toLocaleString()}</div>
                  </div>
                  <div className="score-stat">
                    <div className="k">Next run sends</div>
                    <div className="v">{Math.min(queueSize, status.maxPostsPerRun).toLocaleString()}</div>
                  </div>
                </div>

                {busy && (
                  <div className="progress" style={{ marginTop: '0.9rem' }} role="progressbar" aria-label="Scoring run in progress">
                    <i style={{ width: '45%' }} />
                  </div>
                )}
                {message && (
                  <p style={{ color: 'var(--good)', fontSize: 12, margin: '0.7rem 0 0' }} aria-live="polite">
                    {message}
                  </p>
                )}
                {error && (
                  <p className="error" role="alert" style={{ margin: '0.7rem 0 0' }}>
                    {error}
                  </p>
                )}
              </>
            )}
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <h2>How a post becomes a signal</h2>
          </div>
          <div className="card-body" style={{ color: 'var(--ink-secondary)', fontSize: 12.5, lineHeight: 1.6 }}>
            <p style={{ marginTop: 0 }}>
              <strong style={{ color: 'var(--ink)' }}>1 · Ingest.</strong> Public RSS from five
              subreddits, Hacker News and three per-ticker news queries, deduplicated on
              <code className="mono"> (source, source_post_id)</code>.
            </p>
            <p>
              <strong style={{ color: 'var(--ink)' }}>2 · Filter, free.</strong> A regex plus the
              SEC&apos;s listed-symbol allowlist answers &ldquo;is there even a ticker here&rdquo;
              without spending a token. About 45% of posts resolve at this stage and never reach
              the model.
            </p>
            <p>
              <strong style={{ color: 'var(--ink)' }}>3 · Score.</strong> Survivors go to Gemini
              Flash Lite in batches with their candidate symbols attached. The model judges context
              and mood; it never searches for tickers itself.
            </p>
            <p style={{ marginBottom: 0 }}>
              <strong style={{ color: 'var(--ink)' }}>4 · Validate.</strong> Every numeric bound is
              re-checked locally, invented tickers are dropped, and the returned post ids must match
              the ones sent — so a batched response can never attach one post&apos;s sentiment to
              another.
            </p>
          </div>
        </section>
      </div>

      <section className="card">
        <div className="card-head">
          <h2>Spend brakes</h2>
          <span className="hint">why this button is public</span>
        </div>
        <div className="card-body">
          {status === null ? (
            <Skeleton height={140} />
          ) : (
            <div style={{ display: 'grid', gap: '1rem' }}>
              <div>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span className="metric-label">Manual runs today</span>
                  <span className="num" style={{ fontWeight: 620 }}>
                    {runsUsed} / {status.dailyRunLimit}
                  </span>
                </div>
                <div className="progress"><i style={{ width: `${runPercent}%` }} /></div>
              </div>

              <div>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span className="metric-label">Gemini requests today</span>
                  <span className="num" style={{ fontWeight: 620 }}>
                    {status.requestsUsedToday} / {status.dailyRequestBudget}
                  </span>
                </div>
                <div className="progress"><i style={{ width: `${requestPercent}%` }} /></div>
              </div>

              <dl style={{ margin: 0, display: 'grid', gap: '0.5rem', fontSize: 12 }}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <dt style={{ color: 'var(--ink-muted)' }}>Automatic scoring</dt>
                  <dd style={{ margin: 0 }}>
                    {status.automaticScoringEnabled
                      ? `every ${status.automaticIntervalMinutes} min`
                      : 'disabled'}
                  </dd>
                </div>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <dt style={{ color: 'var(--ink-muted)' }}>Last automatic run</dt>
                  <dd style={{ margin: 0 }}>
                    {status.lastAutomaticRunAt ? timeAgo(status.lastAutomaticRunAt) : 'not yet'}
                  </dd>
                </div>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <dt style={{ color: 'var(--ink-muted)' }}>Next scheduled</dt>
                  <dd style={{ margin: 0 }}>
                    {new Date(status.nextAutomaticRunAt).toLocaleTimeString([], {
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </dd>
                </div>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <dt style={{ color: 'var(--ink-muted)' }}>Batch size</dt>
                  <dd style={{ margin: 0 }}>{status.batchSize} posts per request</dd>
                </div>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <dt style={{ color: 'var(--ink-muted)' }}>Quota resets</dt>
                  <dd style={{ margin: 0 }}>midnight Pacific</dd>
                </div>
              </dl>

              <p className="side-note" style={{ padding: 0 }}>
                The daily counter is reserved under a Postgres advisory lock before the outbound
                call, so overlapping button presses and the automatic timer share one exact budget
                rather than three approximate ones.
              </p>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

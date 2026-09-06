import { formatScore, sentimentColor } from '../api.ts';

/**
 * A diverging bar around a centre tick, plus the signed number.
 *
 * The bar makes a column of tickers scannable; the number makes it exact. Hue
 * never carries the meaning alone, which is what keeps the encoding readable
 * for colour-blind readers and in print.
 */
export function SentimentBar({ score }: { score: number }) {
  const magnitude = Math.min(Math.abs(score), 1) * 50;
  return (
    <span className="sentiment-cell">
      <span className="sent-bar" aria-hidden>
        <i
          style={{
            left: score >= 0 ? '50%' : `${50 - magnitude}%`,
            width: `${magnitude}%`,
            background: sentimentColor(score),
          }}
        />
      </span>
      <span style={{ color: sentimentColor(score), fontWeight: 620, minWidth: '3.1em', textAlign: 'right' }}>
        {formatScore(score)}
      </span>
    </span>
  );
}

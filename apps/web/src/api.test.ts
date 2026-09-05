import { describe, expect, it } from 'vitest';
import { NEUTRAL_BAND, formatScore, polarity, sentimentColor, timeAgo } from './api.ts';

/**
 * The display logic that decides what a reader sees. Pure, so it is tested
 * directly; the rest of the dashboard is verified against the running API.
 */
describe('polarity', () => {
  it('uses the same neutral deadband as spike detection', () => {
    // Drifting from M3's +/-0.2 band would let the UI call something bullish
    // that the detector treats as flat.
    expect(NEUTRAL_BAND).toBe(0.2);
    expect(polarity(0.2)).toBe('neutral');
    expect(polarity(-0.2)).toBe('neutral');
    expect(polarity(0.21)).toBe('bullish');
    expect(polarity(-0.21)).toBe('bearish');
  });

  it('classifies the extremes', () => {
    expect(polarity(1)).toBe('bullish');
    expect(polarity(-1)).toBe('bearish');
    expect(polarity(0)).toBe('neutral');
  });
});

describe('sentimentColor', () => {
  it('maps polarity to the diverging poles, never a third hue', () => {
    expect(sentimentColor(0.9)).toBe('var(--bullish)');
    expect(sentimentColor(-0.9)).toBe('var(--bearish)');
    // Neutral is deliberately muted ink, not a colour: "no signal" should not
    // look like a third category.
    expect(sentimentColor(0)).toBe('var(--ink-muted)');
  });
});

describe('formatScore', () => {
  it('always carries an explicit sign', () => {
    // Sign is the secondary encoding that makes the colour safe for
    // colour-blind readers and in print, so it is never omitted.
    expect(formatScore(0.8)).toBe('+0.80');
    expect(formatScore(-0.8)).toBe('−0.80');
    expect(formatScore(0)).toBe('0.00');
  });

  it('uses a real minus sign rather than a hyphen', () => {
    expect(formatScore(-0.5).startsWith('−')).toBe(true);
  });

  it('rounds to two decimals', () => {
    expect(formatScore(0.126)).toBe('+0.13');
    expect(formatScore(-0.004)).toBe('−0.00');
  });
});

describe('timeAgo', () => {
  it('scales the unit to the gap', () => {
    const now = Date.now();
    expect(timeAgo(new Date(now - 5_000).toISOString())).toMatch(/^\d+s ago$/);
    expect(timeAgo(new Date(now - 5 * 60_000).toISOString())).toBe('5m ago');
    expect(timeAgo(new Date(now - 3 * 3_600_000).toISOString())).toBe('3h ago');
    expect(timeAgo(new Date(now - 2 * 86_400_000).toISOString())).toBe('2d ago');
  });

  it('does not render a negative age for a clock skewed into the future', () => {
    expect(timeAgo(new Date(Date.now() + 60_000).toISOString())).toBe('0s ago');
  });
});

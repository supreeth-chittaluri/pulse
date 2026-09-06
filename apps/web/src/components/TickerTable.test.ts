import { describe, expect, it } from 'vitest';
import { vsBaseline } from './TickerTable.tsx';
import type { TickerSummary } from '../api.ts';

function ticker(overrides: Partial<TickerSummary>): TickerSummary {
  return {
    tickerOrTopic: 'NVDA',
    mentions: 0,
    avgSentiment: 0,
    lastSeenAt: new Date().toISOString(),
    baselineAvgSentiment: null,
    baselineAvgVolume: null,
    series: Array.from({ length: 24 }, () => 0),
    ...overrides,
  };
}

describe('vsBaseline', () => {
  it('is null while the ticker has no baseline yet', () => {
    expect(vsBaseline(ticker({ mentions: 48 }))).toBeNull();
  });

  it('is null for a zero baseline rather than dividing by it', () => {
    expect(vsBaseline(ticker({ mentions: 48, baselineAvgVolume: 0 }))).toBeNull();
  });

  it('compares an hourly rate against the hourly baseline, not a raw total', () => {
    // 48 mentions across the 24 observed hours is 2/hr, which is exactly the
    // baseline. Comparing the raw 48 against 2 would report 24x.
    expect(vsBaseline(ticker({ mentions: 48, baselineAvgVolume: 2 }))).toBeCloseTo(1);
    expect(vsBaseline(ticker({ mentions: 96, baselineAvgVolume: 2 }))).toBeCloseTo(2);
  });

  it('does not divide by zero when the series is empty', () => {
    expect(vsBaseline(ticker({ mentions: 3, baselineAvgVolume: 1, series: [] }))).toBe(3);
  });
});

import { describe, expect, it } from 'vitest';
import {
  detectSpike,
  DEFAULT_DETECTION_CONFIG,
  HOUR_MS,
  type DetectionConfig,
  type Observation,
} from './index.ts';

/**
 * Deterministic RNG. Seeded so a failure is reproducible -- a flaky statistical
 * test is worse than no test, because it trains you to re-run until green.
 */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** Box-Muller, for normally distributed sentiment. */
function normal(random: () => number, mu: number, sigma: number): number {
  const u1 = Math.max(random(), Number.EPSILON);
  const u2 = random();
  return mu + sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

const NOW = Date.UTC(2026, 8, 4, 12, 0, 0);
const WINDOW_START = NOW;

/**
 * Builds a history of `hours` hours ending just before the tested window,
 * at `perHour` mentions per hour with sentiment ~ N(sentimentMean, sentimentSd).
 */
function history(options: {
  hours: number;
  perHour: number;
  sentimentMean: number;
  sentimentSd: number;
  random: () => number;
  source?: string;
}): Observation[] {
  const { hours, perHour, sentimentMean, sentimentSd, random, source = 'reddit:stocks' } = options;
  const out: Observation[] = [];
  for (let h = hours; h >= 1; h -= 1) {
    const bucket = WINDOW_START - h * HOUR_MS;
    for (let i = 0; i < perHour; i += 1) {
      out.push({
        at: bucket + i,
        sentiment: normal(random, sentimentMean, sentimentSd),
        source,
      });
    }
  }
  return out;
}

function currentWindow(options: {
  count: number;
  sentimentMean: number;
  sentimentSd: number;
  random: () => number;
  source?: string;
}): Observation[] {
  const { count, sentimentMean, sentimentSd, random, source = 'reddit:stocks' } = options;
  return Array.from({ length: count }, (_, i) => ({
    at: WINDOW_START + i,
    sentiment: normal(random, sentimentMean, sentimentSd),
    source,
  }));
}

function detect(observations: Observation[], overrides: Partial<DetectionConfig> = {}) {
  return detectSpike(
    { tickerOrTopic: 'TEST', observations, windowStart: WINDOW_START },
    { ...DEFAULT_DETECTION_CONFIG, ...overrides },
  );
}

describe('detectSpike -- flags a real spike', () => {
  it('fires on a large volume surge', () => {
    const random = rng(1);
    const observations = [
      ...history({ hours: 168, perHour: 2, sentimentMean: 0.1, sentimentSd: 0.3, random }),
      ...currentWindow({ count: 40, sentimentMean: 0.1, sentimentSd: 0.3, random }),
    ];

    const { spike } = detect(observations);

    expect(spike).not.toBeNull();
    expect(spike!.mentionCount).toBe(40);
    expect(spike!.volumeZ).toBeGreaterThan(3);
    expect(spike!.baselineAvgVolume).toBeCloseTo(2, 1);
  });

  it('classifies a surge with a sentiment shift as volume+sentiment', () => {
    const random = rng(2);
    const observations = [
      ...history({ hours: 168, perHour: 2, sentimentMean: 0.3, sentimentSd: 0.3, random }),
      // Same surge, but the mood flips hard negative.
      ...currentWindow({ count: 40, sentimentMean: -0.7, sentimentSd: 0.3, random }),
    ];

    const { spike } = detect(observations);

    expect(spike!.kind).toBe('volume+sentiment');
    expect(spike!.sentimentZ).toBeLessThan(-3);
    expect(spike!.currentSentiment).toBeLessThan(-0.5);
  });

  it('classifies a surge with unchanged sentiment as volume only', () => {
    const random = rng(3);
    const observations = [
      ...history({ hours: 168, perHour: 2, sentimentMean: 0.2, sentimentSd: 0.3, random }),
      ...currentWindow({ count: 40, sentimentMean: 0.2, sentimentSd: 0.3, random }),
    ];

    expect(detect(observations).spike!.kind).toBe('volume');
  });

  it('scales with severity', () => {
    const random = rng(4);
    const base = history({ hours: 168, perHour: 2, sentimentMean: 0, sentimentSd: 0.3, random });
    const modest = detect([
      ...base,
      ...currentWindow({ count: 12, sentimentMean: 0, sentimentSd: 0.3, random }),
    ]);
    const extreme = detect([
      ...base,
      ...currentWindow({ count: 80, sentimentMean: 0, sentimentSd: 0.3, random }),
    ]);

    expect(extreme.spike!.volumeZ).toBeGreaterThan(modest.spike!.volumeZ);
  });
});

describe('detectSpike -- does not flag normal noise', () => {
  // The headline acceptance test. A single passing example proves very little
  // about a statistical detector; a rate over many independent series does.
  it('keeps the false-positive rate under 1% across 1000 quiet series', () => {
    let fired = 0;
    const trials = 1000;

    for (let seed = 0; seed < trials; seed += 1) {
      const random = rng(seed + 1000);
      const perHour = 8;
      const observations = [
        ...history({ hours: 168, perHour, sentimentMean: 0.15, sentimentSd: 0.35, random }),
        // Same distribution as the history: nothing has actually happened.
        ...currentWindow({
          count: Math.round(normal(random, perHour, Math.sqrt(perHour))),
          sentimentMean: 0.15,
          sentimentSd: 0.35,
          random,
        }),
      ];
      if (detect(observations).spike !== null) fired += 1;
    }

    expect(fired / trials).toBeLessThan(0.01);
  });

  // Sensitivity is the other half of the claim: a detector that never fires
  // also never produces a false positive. These pin the operating point so a
  // change to the formula cannot quietly trade away detection power.
  it('catches large spikes reliably at a range of baseline volumes', () => {
    const trials = 400;

    for (const perHour of [4, 10, 25]) {
      let fired = 0;
      for (let seed = 0; seed < trials; seed += 1) {
        const random = rng(seed * 7919 + perHour);
        const observations = [
          ...history({ hours: 168, perHour, sentimentMean: 0.15, sentimentSd: 0.35, random }),
          ...currentWindow({
            count: perHour * 5,
            sentimentMean: 0.15,
            sentimentSd: 0.35,
            random,
          }),
        ];
        if (detect(observations).spike !== null) fired += 1;
      }
      // Measured at 98.6-100% across these baselines.
      expect(fired / trials).toBeGreaterThan(0.95);
    }
  });

  it('does not fire on ordinary hour-to-hour variation', () => {
    const random = rng(7);
    const observations = [
      ...history({ hours: 168, perHour: 10, sentimentMean: 0.2, sentimentSd: 0.3, random }),
      ...currentWindow({ count: 13, sentimentMean: 0.2, sentimentSd: 0.3, random }),
    ];

    expect(detect(observations).spike).toBeNull();
  });

  it('does not fire on a sentiment swing without a volume surge', () => {
    const random = rng(8);
    const observations = [
      ...history({ hours: 168, perHour: 10, sentimentMean: 0.3, sentimentSd: 0.3, random }),
      // Mood flipped completely, but nobody is talking about it more than usual.
      ...currentWindow({ count: 10, sentimentMean: -0.9, sentimentSd: 0.1, random }),
    ];

    expect(detect(observations).rejected).toBe('below-threshold');
  });
});

describe('detectSpike -- guards', () => {
  it('refuses to fire below the absolute mention floor', () => {
    const random = rng(9);
    const observations = [
      // A ticker that is essentially never mentioned...
      ...history({ hours: 168, perHour: 0, sentimentMean: 0, sentimentSd: 0.3, random }),
      ...history({ hours: 5, perHour: 5, sentimentMean: 0, sentimentSd: 0.3, random }),
      // ...going to 2 mentions is a huge z, and still not news.
      ...currentWindow({ count: 2, sentimentMean: 0, sentimentSd: 0.3, random }),
    ];

    expect(detect(observations).rejected).toBe('below-mention-floor');
  });

  it('refuses to fire without enough baseline history', () => {
    const random = rng(10);
    const observations = [
      ...history({ hours: 2, perHour: 3, sentimentMean: 0, sentimentSd: 0.3, random }),
      ...currentWindow({ count: 30, sentimentMean: 0, sentimentSd: 0.3, random }),
    ];

    expect(detect(observations).rejected).toBe('no-volume-baseline');
  });

  it('does not divide by zero when history is perfectly flat', () => {
    const observations: Observation[] = [];
    for (let h = 168; h >= 1; h -= 1) {
      for (let i = 0; i < 4; i += 1) {
        // Identical count AND identical sentiment every hour: stddev 0 on both.
        observations.push({ at: WINDOW_START - h * HOUR_MS + i, sentiment: 0.5, source: 'reddit:stocks' });
      }
    }
    observations.push(
      ...Array.from({ length: 40 }, (_, i) => ({
        at: WINDOW_START + i,
        sentiment: 0.5,
        source: 'reddit:stocks',
      })),
    );

    const { spike } = detect(observations);

    expect(spike).not.toBeNull();
    expect(Number.isFinite(spike!.volumeZ)).toBe(true);
    // Sentiment did not move, so its z is 0 and the kind stays volume-only.
    expect(spike!.sentimentZ).toBe(0);
    expect(spike!.kind).toBe('volume');
  });

  it('handles a ticker with no observations at all', () => {
    expect(detect([]).rejected).toBe('below-mention-floor');
  });

  it('honours the cooldown', () => {
    const random = rng(11);
    const observations = [
      ...history({ hours: 168, perHour: 2, sentimentMean: 0, sentimentSd: 0.3, random }),
      ...currentWindow({ count: 40, sentimentMean: 0, sentimentSd: 0.3, random }),
    ];

    const recent = detectSpike(
      {
        tickerOrTopic: 'TEST',
        observations,
        windowStart: WINDOW_START,
        lastDetectedAt: WINDOW_START - 2 * HOUR_MS,
      },
      DEFAULT_DETECTION_CONFIG,
    );
    expect(recent.rejected).toBe('cooldown');

    const expired = detectSpike(
      {
        tickerOrTopic: 'TEST',
        observations,
        windowStart: WINDOW_START,
        lastDetectedAt: WINDOW_START - 24 * HOUR_MS,
      },
      DEFAULT_DETECTION_CONFIG,
    );
    expect(expired.spike).not.toBeNull();
  });

  it('respects a per-ticker threshold override', () => {
    const random = rng(12);
    const observations = [
      ...history({ hours: 168, perHour: 10, sentimentMean: 0, sentimentSd: 0.3, random }),
      ...currentWindow({ count: 22, sentimentMean: 0, sentimentSd: 0.3, random }),
    ];

    const strict = detectSpike(
      { tickerOrTopic: 'TEST', observations, windowStart: WINDOW_START, threshold: 8 },
      DEFAULT_DETECTION_CONFIG,
    );
    const loose = detectSpike(
      { tickerOrTopic: 'TEST', observations, windowStart: WINDOW_START, threshold: 1 },
      DEFAULT_DETECTION_CONFIG,
    );

    expect(strict.spike).toBeNull();
    expect(loose.spike).not.toBeNull();
  });
});

describe('detectSpike -- baseline hygiene', () => {
  // The subtlest failure mode in the whole milestone: if the tested window also
  // feeds the baseline, a big spike raises the mean and inflates the spread,
  // suppressing its own score. The bigger the event, the less it fires.
  it('excludes the tested window from its own baseline', () => {
    const random = rng(13);
    const base = history({ hours: 168, perHour: 2, sentimentMean: 0, sentimentSd: 0.3, random });
    const surge = currentWindow({ count: 60, sentimentMean: 0, sentimentSd: 0.3, random });

    const clean = detect([...base, ...surge]).spike!;

    // Simulate contamination by shifting the surge one hour into the past, so
    // it lands inside the baseline window instead of the tested one.
    const contaminated = detect([
      ...base,
      ...surge.map((o) => ({ ...o, at: o.at - HOUR_MS })),
      ...currentWindow({ count: 60, sentimentMean: 0, sentimentSd: 0.3, random }),
    ]).spike!;

    expect(clean.volumeZ).toBeGreaterThan(contaminated.volumeZ);
    expect(clean.baselineAvgVolume).toBeLessThan(contaminated.baselineAvgVolume);
  });

  it('excludes fixed-cadence news feeds from the volume comparison', () => {
    const random = rng(14);
    const redditHistory = history({
      hours: 168,
      perHour: 2,
      sentimentMean: 0,
      sentimentSd: 0.3,
      random,
    });
    // Google News polls on a timer, adding a near-constant 6/hour that would
    // both inflate the baseline and pad the current window.
    const newsHistory = history({
      hours: 168,
      perHour: 6,
      sentimentMean: 0,
      sentimentSd: 0.3,
      random,
      source: 'news:TEST',
    });

    const withNews = detect([
      ...redditHistory,
      ...newsHistory,
      ...currentWindow({ count: 20, sentimentMean: 0, sentimentSd: 0.3, random }),
      ...currentWindow({ count: 6, sentimentMean: 0, sentimentSd: 0.3, random, source: 'news:TEST' }),
    ]).spike!;

    // The 6 news mentions must not be counted, and the baseline must reflect
    // the 2/hour Reddit rate rather than 8/hour.
    expect(withNews.mentionCount).toBe(20);
    expect(withNews.baselineAvgVolume).toBeCloseTo(2, 0);
  });

  it('still uses news sentiment even though news volume is excluded', () => {
    const random = rng(15);
    const observations = [
      ...history({ hours: 168, perHour: 3, sentimentMean: 0.4, sentimentSd: 0.25, random }),
      ...currentWindow({ count: 30, sentimentMean: -0.6, sentimentSd: 0.25, random }),
      ...currentWindow({
        count: 4,
        sentimentMean: -0.8,
        sentimentSd: 0.1,
        random,
        source: 'news:TEST',
      }),
    ];

    const { spike } = detect(observations);

    // Volume counts only the 30 Reddit mentions...
    expect(spike!.mentionCount).toBe(30);
    // ...but the news sentiment still pulls the window average, since a feed's
    // cadence is artificial while what it says is not.
    expect(spike!.currentSentiment).toBeLessThan(-0.5);
    expect(spike!.kind).toBe('volume+sentiment');
  });
});

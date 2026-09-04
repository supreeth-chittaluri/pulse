import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '@pulse/core';
import type { Clock, Source } from '@pulse/sources';
import { computeDelayMs, runScheduler } from './scheduler.ts';

function testClock(): Clock & { time: number } {
  const clock = {
    time: 0,
    now() {
      return clock.time;
    },
    async sleep(ms: number) {
      clock.time += ms;
    },
  };
  return clock;
}

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function fakeSource(id: string, pollSeconds: number): Source {
  return {
    id,
    adapter: 'fake',
    pollSeconds,
    rateLimitBucket: null,
    fetch: async () => [],
  };
}

/** Runs the scheduler until `run` has been called `stopAfter` times. */
async function runUntil(
  sources: Source[],
  stopAfter: number,
  behaviour: (source: Source, call: number) => Promise<void> = async () => {},
  options: Partial<Parameters<typeof runScheduler>[0]> = {},
) {
  const clock = testClock();
  const controller = new AbortController();
  const calls: Array<{ id: string; at: number }> = [];

  await runScheduler({
    sources,
    logger: silentLogger,
    clock,
    // Deterministic jitter: random() === 0.5 means zero offset.
    random: () => 0.5,
    signal: controller.signal,
    run: async (source) => {
      calls.push({ id: source.id, at: clock.time });
      const index = calls.length;
      try {
        await behaviour(source, index);
      } finally {
        if (calls.length >= stopAfter) controller.abort();
      }
    },
    ...options,
  });

  return { calls, clock };
}

describe('computeDelayMs', () => {
  it('returns the configured interval on success', () => {
    expect(computeDelayMs(600, 0, { jitterPct: 0 })).toBe(600_000);
  });

  it('doubles the interval per consecutive failure', () => {
    const uncapped = { jitterPct: 0, maxBackoffMs: Number.MAX_SAFE_INTEGER };
    expect(computeDelayMs(600, 1, uncapped)).toBe(1_200_000);
    expect(computeDelayMs(600, 2, uncapped)).toBe(2_400_000);
    expect(computeDelayMs(600, 3, uncapped)).toBe(4_800_000);
  });

  it('reaches the default 1h cap on the third failure at our 600s interval', () => {
    // Worth pinning: every configured source polls at 600s or slower, so a
    // dead feed settles at one retry per hour rather than climbing forever.
    expect(computeDelayMs(600, 2, { jitterPct: 0 })).toBe(2_400_000);
    expect(computeDelayMs(600, 3, { jitterPct: 0 })).toBe(3_600_000);
    expect(computeDelayMs(600, 10, { jitterPct: 0 })).toBe(3_600_000);
  });

  it('caps backoff so a dead feed still retries eventually', () => {
    expect(computeDelayMs(600, 20, { jitterPct: 0, maxBackoffMs: 3_600_000 })).toBe(3_600_000);
  });

  it('keeps jitter within the configured spread', () => {
    for (const random of [() => 0, () => 0.5, () => 1]) {
      const delay = computeDelayMs(600, 0, { jitterPct: 0.1, random });
      expect(delay).toBeGreaterThanOrEqual(540_000);
      expect(delay).toBeLessThanOrEqual(660_000);
    }
    expect(computeDelayMs(600, 0, { jitterPct: 0.1, random: () => 0 })).toBe(540_000);
    expect(computeDelayMs(600, 0, { jitterPct: 0.1, random: () => 1 })).toBe(660_000);
  });

  it('never returns a negative delay', () => {
    expect(computeDelayMs(0, 0, { jitterPct: 0.5, random: () => 0 })).toBe(0);
  });
});

describe('runScheduler', () => {
  it('fetches every source immediately at startup by default', async () => {
    const sources = [fakeSource('a', 600), fakeSource('b', 900)];
    const { calls } = await runUntil(sources, 2);

    expect(calls.map((c) => c.id).sort()).toEqual(['a', 'b']);
    expect(calls.every((c) => c.at === 0)).toBe(true);
  });

  it('waits out the first interval when runImmediately is false', async () => {
    const { calls } = await runUntil([fakeSource('a', 600)], 1, undefined, {
      runImmediately: false,
    });

    expect(calls[0]?.at).toBe(600_000);
  });

  it('re-runs a source on its own interval', async () => {
    const { calls } = await runUntil([fakeSource('a', 600)], 3);

    expect(calls.map((c) => c.at)).toEqual([0, 600_000, 1_200_000]);
  });

  it('interleaves sources by their individual intervals', async () => {
    const sources = [fakeSource('fast', 100), fakeSource('slow', 300)];
    const { calls } = await runUntil(sources, 6);

    // fast at 0/100/200/300s, slow at 0/300s.
    expect(calls.filter((c) => c.id === 'fast').map((c) => c.at)).toEqual([
      0, 100_000, 200_000, 300_000,
    ]);
    expect(calls.filter((c) => c.id === 'slow').map((c) => c.at)).toEqual([0, 300_000]);
  });

  it('keeps running the other sources when one throws', async () => {
    const sources = [fakeSource('broken', 100), fakeSource('healthy', 100)];
    const { calls } = await runUntil(sources, 6, async (source) => {
      if (source.id === 'broken') throw new Error('feed is down');
    });

    // The healthy source must keep its cadence regardless of its neighbour.
    expect(calls.filter((c) => c.id === 'healthy').length).toBeGreaterThanOrEqual(3);
    expect(calls.filter((c) => c.id === 'broken').length).toBeGreaterThanOrEqual(1);
  });

  it('backs a failing source off exponentially', async () => {
    const { calls } = await runUntil([fakeSource('broken', 100)], 4, async () => {
      throw new Error('feed is down');
    });

    // 0, then +200s, then +400s, then +800s.
    expect(calls.map((c) => c.at)).toEqual([0, 200_000, 600_000, 1_400_000]);
  });

  it('returns to the normal interval once a source recovers', async () => {
    const { calls } = await runUntil([fakeSource('flaky', 100)], 4, async (_source, call) => {
      if (call <= 2) throw new Error('transient');
    });

    // fail at 0, fail at +200s, succeed at +400s, then back to +100s.
    expect(calls.map((c) => c.at)).toEqual([0, 200_000, 600_000, 700_000]);
  });

  it('stops promptly when aborted', async () => {
    const clock = testClock();
    const controller = new AbortController();
    const run = vi.fn(async () => {});

    controller.abort();
    await runScheduler({
      sources: [fakeSource('a', 600)],
      logger: silentLogger,
      clock,
      signal: controller.signal,
      run,
    });

    expect(run).not.toHaveBeenCalled();
  });

  it('returns immediately when there are no sources', async () => {
    const warn = vi.fn();
    await runScheduler({
      sources: [],
      logger: { ...silentLogger, warn },
      run: async () => {},
    });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no enabled sources'));
  });
});

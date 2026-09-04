import { describe, expect, it } from 'vitest';
import { MinIntervalGate, type Clock } from './rate-limit.ts';

/**
 * Virtual clock: sleeps advance time instantly, so we assert the gate's
 * decisions rather than waiting out real minutes.
 */
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

describe('MinIntervalGate', () => {
  it('lets the first acquire through with no wait', async () => {
    const clock = testClock();
    const gate = new MinIntervalGate(60_000, clock);

    await gate.acquire('reddit');

    expect(clock.time).toBe(0);
  });

  it('spaces sequential acquires in the same bucket', async () => {
    const clock = testClock();
    const gate = new MinIntervalGate(60_000, clock);

    await gate.acquire('reddit');
    await gate.acquire('reddit');
    await gate.acquire('reddit');

    // This is the bug M0 hit for real: three back-to-back Reddit fetches
    // returned 429. Each must now be a full interval apart.
    expect(clock.time).toBe(120_000);
  });

  it('spaces concurrent acquires in the same bucket', async () => {
    const clock = testClock();
    const gate = new MinIntervalGate(60_000, clock);

    // Three sources firing at once is the realistic case: the scheduler runs
    // serially, but nothing in the gate's contract assumes that.
    await Promise.all(['a', 'b', 'c'].map(() => gate.acquire('reddit')));

    // Virtual time is shared, so per-caller timestamps race; total elapsed
    // time is the honest assertion. Ordering is covered by the next test.
    expect(clock.time).toBe(120_000);
  });

  it('preserves arrival order', async () => {
    const clock = testClock();
    const gate = new MinIntervalGate(1_000, clock);

    const order: string[] = [];
    await Promise.all(
      ['first', 'second', 'third'].map(async (name) => {
        await gate.acquire('reddit');
        order.push(name);
      }),
    );

    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('does not let one bucket block another', async () => {
    const clock = testClock();
    const gate = new MinIntervalGate(60_000, clock);

    await gate.acquire('reddit');
    await gate.acquire('other');

    // Hacker News and Google News must not queue behind Reddit.
    expect(clock.time).toBe(0);
  });

  it('treats a null bucket as unlimited', async () => {
    const clock = testClock();
    const gate = new MinIntervalGate(60_000, clock);

    await gate.acquire(null);
    await gate.acquire(null);
    await gate.acquire(null);

    expect(clock.time).toBe(0);
  });

  it('does not wait when the interval has already elapsed', async () => {
    const clock = testClock();
    const gate = new MinIntervalGate(60_000, clock);

    await gate.acquire('reddit');
    clock.time += 90_000;
    await gate.acquire('reddit');

    expect(clock.time).toBe(90_000);
  });

  it('reports the remaining wait for a bucket', async () => {
    const clock = testClock();
    const gate = new MinIntervalGate(60_000, clock);

    expect(gate.waitTimeMs('reddit')).toBe(0);
    await gate.acquire('reddit');
    expect(gate.waitTimeMs('reddit')).toBe(60_000);

    clock.time += 25_000;
    expect(gate.waitTimeMs('reddit')).toBe(35_000);

    clock.time += 100_000;
    expect(gate.waitTimeMs('reddit')).toBe(0);
    expect(gate.waitTimeMs(null)).toBe(0);
  });

  it('rejects a negative interval', () => {
    expect(() => new MinIntervalGate(-1)).toThrow(RangeError);
  });

  it('keeps serving a bucket after a caller rejects', async () => {
    const clock = testClock();
    const gate = new MinIntervalGate(60_000, clock);

    // A failed fetch must not poison the queue for every later Reddit source.
    await gate.acquire('reddit');
    await Promise.reject(new Error('fetch blew up')).catch(() => {});
    await gate.acquire('reddit');

    expect(clock.time).toBe(60_000);
  });
});

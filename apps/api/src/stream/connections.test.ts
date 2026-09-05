import { describe, expect, it } from 'vitest';
import { ConnectionRegistry } from './connections.ts';

/**
 * Connection accounting is tested here rather than through live sockets.
 *
 * Driving it over HTTP made the suite unreliable: whether a client disconnect
 * is observed depends on the HTTP client and its connection pooling, and when
 * client and server share one process under the test runner, socket closes are
 * not delivered dependably at all. The behaviour was verified correct against a
 * real out-of-process client; these tests pin the logic deterministically.
 */
function registry(max = 100, perIp = 3): ConnectionRegistry {
  return new ConnectionRegistry({ maxConnections: max, maxConnectionsPerIp: perIp });
}

describe('ConnectionRegistry', () => {
  it('admits connections up to the per-client cap', () => {
    const r = registry(100, 3);

    expect(r.acquire('1.1.1.1').ok).toBe(true);
    expect(r.acquire('1.1.1.1').ok).toBe(true);
    expect(r.acquire('1.1.1.1').ok).toBe(true);
    expect(r.total).toBe(3);

    const fourth = r.acquire('1.1.1.1');
    expect(fourth).toEqual({ ok: false, status: 429, reason: 'too_many_streams' });
    // A rejected connection must not consume a slot.
    expect(r.total).toBe(3);
  });

  it('caps clients independently of one another', () => {
    const r = registry(100, 2);

    r.acquire('1.1.1.1');
    r.acquire('1.1.1.1');
    expect(r.acquire('1.1.1.1').ok).toBe(false);

    // One noisy client must not lock everyone else out.
    expect(r.acquire('2.2.2.2').ok).toBe(true);
    expect(r.total).toBe(3);
  });

  it('enforces the global cap before the per-client one', () => {
    const r = registry(2, 5);

    r.acquire('1.1.1.1');
    r.acquire('2.2.2.2');

    // Under the per-client limit, but the process is full.
    expect(r.acquire('3.3.3.3')).toEqual({
      ok: false,
      status: 503,
      reason: 'stream_unavailable',
    });
  });

  it('frees the slot on release', () => {
    const r = registry(100, 1);

    expect(r.acquire('1.1.1.1').ok).toBe(true);
    expect(r.acquire('1.1.1.1').ok).toBe(false);

    r.release('1.1.1.1');

    expect(r.total).toBe(0);
    expect(r.acquire('1.1.1.1').ok).toBe(true);
  });

  it('forgets a client once its last connection closes', () => {
    const r = registry();

    r.acquire('1.1.1.1');
    r.acquire('1.1.1.1');
    r.release('1.1.1.1');
    expect(r.countFor('1.1.1.1')).toBe(1);
    expect(r.clients).toBe(1);

    r.release('1.1.1.1');
    // The map must not retain an entry per IP ever seen; that is a slow leak.
    expect(r.clients).toBe(0);
    expect(r.countFor('1.1.1.1')).toBe(0);
  });

  it('never lets the counter drift below zero', () => {
    const r = registry(2, 2);

    // A double release would otherwise raise the effective cap permanently.
    r.acquire('1.1.1.1');
    r.release('1.1.1.1');
    r.release('1.1.1.1');
    r.release('1.1.1.1');

    expect(r.total).toBe(0);
    expect(r.acquire('1.1.1.1').ok).toBe(true);
    expect(r.acquire('2.2.2.2').ok).toBe(true);
    expect(r.acquire('3.3.3.3').ok).toBe(false); // global cap of 2 still holds
  });

  it('releases an unknown client without throwing', () => {
    const r = registry();
    expect(() => r.release('never-seen')).not.toThrow();
    expect(r.total).toBe(0);
  });

  it('recovers full capacity after a full drain', () => {
    const r = registry(3, 3);
    const ips = ['1.1.1.1', '2.2.2.2', '3.3.3.3'];

    for (const ip of ips) expect(r.acquire(ip).ok).toBe(true);
    expect(r.acquire('4.4.4.4').ok).toBe(false);

    for (const ip of ips) r.release(ip);

    expect(r.total).toBe(0);
    expect(r.clients).toBe(0);
    for (const ip of ips) expect(r.acquire(ip).ok).toBe(true);
  });
});

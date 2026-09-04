import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword, dummyVerify } from './password.ts';

describe('hashPassword', () => {
  it('produces a verifiable hash', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
  });

  it('salts, so the same password hashes differently every time', async () => {
    const a = await hashPassword('same-password');
    const b = await hashPassword('same-password');
    expect(a).not.toBe(b);
    expect(await verifyPassword('same-password', a)).toBe(true);
    expect(await verifyPassword('same-password', b)).toBe(true);
  });

  it('records its parameters so they can be raised later', async () => {
    // Encoding N/r/p means an old hash stays verifiable after the cost is
    // increased for new ones.
    const [scheme, N, r, p] = (await hashPassword('x'.repeat(12))).split('$');
    expect(scheme).toBe('scrypt');
    expect(Number(N)).toBe(32768);
    expect([Number(r), Number(p)]).toEqual([8, 1]);
  });

  it('refuses a password shorter than 8 characters', async () => {
    await expect(hashPassword('short')).rejects.toThrow(/at least 8/);
  });
});

describe('verifyPassword', () => {
  it('rejects the wrong password', async () => {
    const hash = await hashPassword('the-right-one');
    expect(await verifyPassword('the-wrong-one', hash)).toBe(false);
  });

  it('is not fooled by a prefix or an empty password', async () => {
    const hash = await hashPassword('abcdefghij');
    expect(await verifyPassword('abcdefghi', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  });

  // A corrupted row must be a failed login, not a 500 that confirms the
  // account exists.
  it('returns false rather than throwing on a malformed stored hash', async () => {
    for (const stored of [
      '',
      'not-a-hash',
      'scrypt$32768$8$1$onlyfivefields',
      'bcrypt$32768$8$1$c2FsdA==$aGFzaA==',
      'scrypt$notanumber$8$1$c2FsdA==$aGFzaA==',
      'scrypt$32768$8$1$c2FsdA==$',
    ]) {
      expect(await verifyPassword('anything', stored), stored).toBe(false);
    }
  });
});

describe('dummyVerify', () => {
  it('always returns false', async () => {
    expect(await dummyVerify('anything')).toBe(false);
  });

  // Guards against user enumeration by response timing. Generous bounds: this
  // asserts the same order of magnitude, not a precise duration, so it does not
  // become flaky on a loaded machine.
  it('costs roughly as much as a real verification', async () => {
    const hash = await hashPassword('a-real-password');

    const realStart = performance.now();
    await verifyPassword('a-wrong-password', hash);
    const real = performance.now() - realStart;

    const dummyStart = performance.now();
    await dummyVerify('a-wrong-password');
    const dummy = performance.now() - dummyStart;

    expect(dummy).toBeGreaterThan(real * 0.2);
    expect(dummy).toBeLessThan(real * 5);
  });
});

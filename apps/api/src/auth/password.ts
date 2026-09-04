import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { promisify } from 'node:util';

// promisify resolves to the 3-argument overload, which drops the cost
// parameters; assert the 4-argument form so N/r/p are actually applied.
const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

/**
 * scrypt from node:crypto -- built in, so no native module and no third-party
 * supply chain for the one thing in the app that must not be compromised.
 *
 * N=2^15 with r=8 is the OWASP-recommended floor and costs ~32MB per hash,
 * which is fine for a login path measured in requests per hour.
 */
const PARAMS = { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };
const KEY_LENGTH = 64;
const SALT_BYTES = 16;

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 8) throw new Error('Password must be at least 8 characters');
  const salt = randomBytes(SALT_BYTES);
  const derived = await scryptAsync(password, salt, KEY_LENGTH, PARAMS);
  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/**
 * Constant-time verification. Returns false rather than throwing on a malformed
 * stored hash, so a corrupted row is a failed login and not a 500 that reveals
 * the account exists.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isSafeInteger(N) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p)) {
    return false;
  }

  let expected: Buffer;
  try {
    expected = Buffer.from(parts[5]!, 'base64');
  } catch {
    return false;
  }
  if (expected.length === 0) return false;

  try {
    const salt = Buffer.from(parts[4]!, 'base64');
    const derived = await scryptAsync(password, salt, expected.length, {
      N,
      r,
      p,
      maxmem: PARAMS.maxmem,
    });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/**
 * Burns roughly the same time as a real verification.
 *
 * Called when no user matches, so "unknown email" and "wrong password" take
 * comparable time and the login endpoint cannot be used to enumerate accounts.
 */
export async function dummyVerify(password: string): Promise<false> {
  await scryptAsync(password, randomBytes(SALT_BYTES), KEY_LENGTH, PARAMS);
  return false;
}

import { SignJWT, jwtVerify } from 'jose';
import type { UserRole } from '@pulse/core';

export type TokenPayload = { sub: string; email: string; role: UserRole };

const ISSUER = 'pulse';
const AUDIENCE = 'pulse-api';

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function signToken(
  payload: TokenPayload,
  secret: string,
  ttlHours: number,
): Promise<string> {
  return new SignJWT({ email: payload.email, role: payload.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ttlHours}h`)
    .sign(key(secret));
}

/** Returns null for anything not a currently-valid token we issued. */
export async function verifyToken(
  token: string,
  secret: string,
): Promise<TokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
    });
    const role = payload.role;
    if (role !== 'demo' && role !== 'admin') return null;
    if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') return null;
    return { sub: payload.sub, email: payload.email, role };
  } catch {
    return null;
  }
}

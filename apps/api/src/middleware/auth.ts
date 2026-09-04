import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { UserRole } from '@pulse/core';
import { verifyToken, type TokenPayload } from '../auth/tokens.ts';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: TokenPayload;
    }
  }
}

/**
 * Attaches req.user when a valid Bearer token is present, and does nothing
 * otherwise.
 *
 * Never rejects: reads are anonymous by design (M8 requires a stranger to load
 * the dashboard with no login), so an absent or bad token simply means "not
 * signed in". Enforcement lives in requireRole.
 */
export function attachUser(secret: string): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const header = req.get('authorization');
    if (header?.startsWith('Bearer ')) {
      const payload = await verifyToken(header.slice('Bearer '.length).trim(), secret);
      if (payload) req.user = payload;
    }
    next();
  };
}

/**
 * Gate for a role.
 *
 * 401 means "we do not know who you are", 403 means "we do and you may not" --
 * the distinction matters because the M4 acceptance test is specifically that
 * a demo token on an admin route gets 403, not 401.
 */
export function requireRole(role: UserRole): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({ error: 'unauthorized', message: 'Sign in to use this endpoint.' });
      return;
    }
    if (req.user.role !== role) {
      res.status(403).json({
        error: 'forbidden',
        message: `This endpoint requires the ${role} role.`,
      });
      return;
    }
    next();
  };
}

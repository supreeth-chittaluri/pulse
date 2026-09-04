import { Router } from 'express';
import { z } from 'zod';
import { findUserByEmail, recordLogin, type Config, type Logger, type Pool } from '@pulse/core';
import { dummyVerify, verifyPassword } from '../auth/password.ts';
import { signToken } from '../auth/tokens.ts';

const loginSchema = z.object({
  email: z.string().trim().min(3).max(320),
  password: z.string().min(1).max(200),
});

/**
 * The message the fake signup flow shows in M6. Stated plainly rather than
 * pretending to accept a registration -- a form that looks like it worked and
 * silently did nothing is worse than an honest refusal.
 */
export const PRIVATE_DEMO_MESSAGE =
  'pulse is a private portfolio demo, so public signup is disabled. ' +
  'Use the demo credentials shown on the login screen to explore a read-only ' +
  'view of live data.';

export function authRoutes(pool: Pool, config: Config, logger: Logger): Router {
  const router = Router();

  router.post('/login', async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', message: 'Email and password are required.' });
      return;
    }

    const { email, password } = parsed.data;
    const user = await findUserByEmail(pool, email);

    // Burn comparable time when the account does not exist, so response timing
    // cannot be used to enumerate valid emails.
    const ok = user ? await verifyPassword(password, user.passwordHash) : await dummyVerify(password);

    if (!user || !ok) {
      logger.warn('failed login', { email: email.toLowerCase() });
      // One message for both cases, for the same reason.
      res.status(401).json({ error: 'invalid_credentials', message: 'Invalid email or password.' });
      return;
    }

    await recordLogin(pool, user.id);
    const token = await signToken(
      { sub: String(user.id), email: user.email, role: user.role },
      config.auth.jwtSecret,
      config.auth.jwtTtlHours,
    );

    logger.info('login', { email: user.email, role: user.role });
    res.json({
      token,
      role: user.role,
      email: user.email,
      expiresInSeconds: config.auth.jwtTtlHours * 3600,
    });
  });

  router.get('/me', (req, res) => {
    if (!req.user) {
      res.status(401).json({ error: 'unauthorized', authenticated: false });
      return;
    }
    res.json({ authenticated: true, email: req.user.email, role: req.user.role });
  });

  // Tokens are stateless and short-lived, so there is nothing to revoke
  // server-side; the client discards it. Present so the UI has a real endpoint
  // to call rather than pretending.
  router.post('/logout', (_req, res) => {
    res.json({ ok: true });
  });

  router.post('/signup', (_req, res) => {
    res.status(403).json({ error: 'signup_disabled', message: PRIVATE_DEMO_MESSAGE });
  });

  return router;
}

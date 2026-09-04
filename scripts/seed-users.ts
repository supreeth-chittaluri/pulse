/**
 * Seeds the demo and admin accounts from .env.
 *
 *   npm run db:seed
 *
 * The admin password has no default and never will: a checked-in or guessable
 * admin credential on a public deployment is the whole ballgame. The demo
 * account is read-only by design, so a weak password there costs nothing.
 */
import { createPool, loadConfig, upsertUser, countUsers } from '@pulse/core';
import { hashPassword } from '../apps/api/src/auth/password.ts';

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);

  const demoEmail = process.env.DEMO_USER_EMAIL ?? 'demo@pulse.local';
  const demoPassword = process.env.DEMO_USER_PASSWORD ?? 'demo-read-only';
  const adminEmail = process.env.ADMIN_USER_EMAIL;
  const adminPassword = process.env.ADMIN_USER_PASSWORD;

  await upsertUser(pool, demoEmail, 'demo', await hashPassword(demoPassword));
  console.log(`  demo   ${demoEmail}`);

  if (!adminEmail || !adminPassword) {
    console.log('\n  admin  SKIPPED -- set ADMIN_USER_EMAIL and ADMIN_USER_PASSWORD in .env');
    console.log('         Generate a password with:');
    console.log("         node -e \"console.log(require('crypto').randomBytes(24).toString('base64url'))\"");
  } else if (adminPassword.length < 12) {
    throw new Error('ADMIN_USER_PASSWORD must be at least 12 characters.');
  } else {
    await upsertUser(pool, adminEmail, 'admin', await hashPassword(adminPassword));
    console.log(`  admin  ${adminEmail}`);
  }

  console.log(`\n${await countUsers(pool)} user(s) in the database.\n`);
  await pool.end();
}

main().catch((err: unknown) => {
  console.error(`\n${(err as Error).message}\n`);
  process.exit(1);
});

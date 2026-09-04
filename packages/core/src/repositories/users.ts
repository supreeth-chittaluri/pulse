import type { Pool } from 'pg';
import type { UserRole } from '../types.ts';

export type User = {
  id: number;
  email: string;
  role: UserRole;
  passwordHash: string;
};

/** Emails are stored and compared lowercased. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function findUserByEmail(pool: Pool, email: string): Promise<User | null> {
  const { rows } = await pool.query<{
    id: string;
    email: string;
    role: UserRole;
    password_hash: string;
  }>('select id, email, role, password_hash from users where email = $1', [
    normalizeEmail(email),
  ]);
  const row = rows[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    email: row.email,
    role: row.role,
    passwordHash: row.password_hash,
  };
}

export async function upsertUser(
  pool: Pool,
  email: string,
  role: UserRole,
  passwordHash: string,
): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into users (email, role, password_hash)
     values ($1, $2, $3)
     on conflict (email) do update set role = excluded.role, password_hash = excluded.password_hash
     returning id`,
    [normalizeEmail(email), role, passwordHash],
  );
  return Number(rows[0]!.id);
}

export async function recordLogin(pool: Pool, id: number): Promise<void> {
  await pool.query('update users set last_login_at = now() where id = $1', [id]);
}

export async function countUsers(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ count: string }>('select count(*) from users');
  return Number(rows[0]?.count ?? 0);
}

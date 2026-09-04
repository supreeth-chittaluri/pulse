import pg from 'pg';

const { Pool } = pg;

/**
 * Postgres returns numeric as a string to avoid float precision loss. Our
 * sentiment scores and z-scores are small and bounded, so parse them to
 * numbers -- otherwise every consumer has to remember to Number() them.
 */
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value: string) => Number(value));

export function createPool(databaseUrl: string): pg.Pool {
  return new Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // Managed free-tier Postgres (Neon, Render) requires TLS; local docker does not.
    ssl: /\blocalhost\b|\b127\.0\.0\.1\b/.test(databaseUrl)
      ? undefined
      : { rejectUnauthorized: false },
  });
}

export type { Pool } from 'pg';

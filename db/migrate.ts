/**
 * Idempotent migration runner. Applies every db/NNN_*.sql file in filename
 * order exactly once, tracking applied files in schema_migrations.
 *
 *   npm run db:migrate
 */
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import type { Pool } from 'pg';
import { loadConfig } from '../packages/core/src/config.ts';
import { createPool } from '../packages/core/src/db.ts';

const here = dirname(fileURLToPath(import.meta.url));

export type MigrateOptions = {
  /** Directory of NNN_*.sql files. Defaults to this directory. */
  dir?: string;
  /** Suppress per-file output. Tests set this. */
  quiet?: boolean;
};

/**
 * Exported so the test harness can migrate a throwaway database without
 * shelling out to the CLI.
 */
export async function runMigrations(pool: Pool, options: MigrateOptions = {}): Promise<number> {
  const dir = options.dir ?? here;
  const log = options.quiet ? () => {} : (line: string) => console.log(line);

  await pool.query(`
    create table if not exists schema_migrations (
      filename   text        primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const files = (await readdir(dir))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const { rows } = await pool.query<{ filename: string }>(
    'select filename from schema_migrations',
  );
  const applied = new Set(rows.map((r) => r.filename));

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) {
      log(`  skip  ${file} (already applied)`);
      continue;
    }
    const sql = await readFile(join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into schema_migrations (filename) values ($1)', [file]);
      await client.query('commit');
      log(`  apply ${file}`);
      count += 1;
    } catch (err) {
      await client.query('rollback');
      throw new Error(`migration ${file} failed: ${(err as Error).message}`, { cause: err });
    } finally {
      client.release();
    }
  }

  return count;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  try {
    const count = await runMigrations(pool);
    console.log(count === 0 ? 'Database already up to date.' : `Applied ${count} migration(s).`);
  } finally {
    await pool.end();
  }
}

// Only run as a CLI, not when the test harness imports runMigrations.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}

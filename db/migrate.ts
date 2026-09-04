/**
 * Idempotent migration runner. Applies every db/NNN_*.sql file in filename
 * order exactly once, tracking applied files in schema_migrations.
 *
 *   npm run db:migrate
 */
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig } from '../packages/core/src/config.ts';
import { createPool } from '../packages/core/src/db.ts';

const here = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);

  await pool.query(`
    create table if not exists schema_migrations (
      filename   text        primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const files = (await readdir(here))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const { rows } = await pool.query<{ filename: string }>(
    'select filename from schema_migrations',
  );
  const applied = new Set(rows.map((r) => r.filename));

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`  skip  ${file} (already applied)`);
      continue;
    }
    const sql = await readFile(join(here, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into schema_migrations (filename) values ($1)', [file]);
      await client.query('commit');
      console.log(`  apply ${file}`);
      count += 1;
    } catch (err) {
      await client.query('rollback');
      throw new Error(`migration ${file} failed: ${(err as Error).message}`, { cause: err });
    } finally {
      client.release();
    }
  }

  console.log(count === 0 ? 'Database already up to date.' : `Applied ${count} migration(s).`);
  await pool.end();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/;

export async function runMigrations(pool, dir) {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );

  const files = fs
    .readdirSync(dir)
    .filter((f) => MIGRATION_FILE.test(f))
    .sort();

  let applied = 0;
  for (const file of files) {
    const seen = await pool.query(
      'SELECT 1 FROM schema_migrations WHERE version = $1',
      [file],
    );
    if (seen.rowCount > 0) continue;

    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [
        file,
      ]);
      await client.query('COMMIT');
      applied += 1;
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${err.message}`, { cause: err });
    } finally {
      client.release();
    }
  }
  return applied;
}

export const migrationsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'migrations',
);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await import('dotenv/config');
  const { getConfig } = await import('../config.js');
  const { getPool } = await import('./pool.js');
  const pool = getPool(getConfig());
  const n = await runMigrations(pool, migrationsDir);
  console.log(`migrations applied: ${n}`);
  await pool.end();
}

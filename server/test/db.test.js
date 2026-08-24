import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { runMigrations } from '../src/db/migrate.js';
import { getPool, makeQuery } from '../src/db/pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const ADMIN_URL = 'postgres://postgres:postgres@localhost:5432/postgres';
const SCRATCH_DB = process.env.SCRATCH_DB ?? 'hcm_scratch_test';

describe('migration runner', () => {
  const admin = new pg.Client({ connectionString: ADMIN_URL });

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
    await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);
  });

  afterAll(async () => {
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`).catch(() => {});
    await admin.end();
  });

  it('applies every migration to an empty database, inside transactions', async () => {
    const pool = getPool({
      databaseUrl: `postgres://postgres:postgres@localhost:5432/${SCRATCH_DB}`,
    });
    const appliedCount = await runMigrations(pool, MIGRATIONS_DIR);
    expect(appliedCount).toBeGreaterThan(0);

    const tables = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' ORDER BY table_name`,
    );
    const names = tables.rows.map((r) => r.table_name);
    for (const expected of [
      'users', 'doctors', 'leave_days', 'appointments',
      'pre_visit_summaries', 'visit_notes', 'post_visit_summaries',
      'email_queue', 'calendar_events', 'notification_log',
      'appointment_events', 'job_state', 'schema_migrations',
    ]) {
      expect(names).toContain(expected);
    }

    const partialIndex = await pool.query(
      `SELECT indexname FROM pg_indexes
       WHERE tablename = 'appointments'
         AND indexdef LIKE '%WHERE%(%status%'`,
    );
    expect(partialIndex.rowCount).toBeGreaterThanOrEqual(2);

    await pool.end();
  });

  it('second run is a forward-only no-op (0 statements applied)', async () => {
    const pool = getPool({
      databaseUrl: `postgres://postgres:postgres@localhost:5432/${SCRATCH_DB}`,
    });
    const again = await runMigrations(pool, MIGRATIONS_DIR);
    expect(again).toBe(0);
    await pool.end();
  });
});

describe('pool helper', () => {
  it('makeQuery binds parameterized queries to its pool', async () => {
    const pool = getPool({ databaseUrl: ADMIN_URL });
    const query = makeQuery(pool);
    const r = await query('SELECT $1::int + $2::int AS sum', [2, 3]);
    expect(r.rows[0].sum).toBe(5);
    await pool.end();
  });
});

import { loadConfig } from '../src/config.js';
import { getPool } from '../src/db/pool.js';
import { runMigrations, migrationsDir } from '../src/db/migrate.js';

export function testConfig(overrides = {}) {
  return loadConfig({
    DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/hcm_test',
    JWT_SECRET: 'test-jwt-secret-not-for-production',
    JOB_SECRET: 'test-job-secret',
    ...overrides,
  });
}

let sharedPool;

export async function getTestPool() {
  if (!sharedPool) {
    sharedPool = getPool(testConfig());
    await runMigrations(sharedPool, migrationsDir);
  }
  return sharedPool;
}

export async function resetDb() {
  const pool = await getTestPool();
  await pool.query(`
    TRUNCATE appointment_events, calendar_events, notification_log,
             email_queue, post_visit_summaries, visit_notes,
             pre_visit_summaries, appointments, leave_days, doctors, users
    RESTART IDENTITY CASCADE
  `);
  return pool;
}

export async function insertUser(pool, { email, name = 'Test User', role = 'patient', phone = null }) {
  const { rows } = await pool.query(
    `INSERT INTO users (role, email, password_hash, name, phone)
     VALUES ($1, $2, 'x', $3, $4) RETURNING id`,
    [role, email.toLowerCase().trim(), name, phone],
  );
  return rows[0].id;
}

export async function closeTestPool() {
  if (sharedPool) {
    await sharedPool.end();
    sharedPool = undefined;
  }
}

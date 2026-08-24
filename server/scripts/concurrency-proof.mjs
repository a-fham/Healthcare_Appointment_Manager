/**
 * Stand-alone concurrency proof (assignment deliverable).
 *
 * Spins up the real app against a scratch database schema state, fires N
 * simultaneous hold requests at ONE open slot from N distinct patients, and
 * prints the verdict: exactly one 201, everyone else 409 SLOT_TAKEN, and a
 * single live 'held' row. Run: node scripts/concurrency-proof.mjs
 */
import 'dotenv/config';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { loadConfig } from '../src/config.js';
import { getPool } from '../src/db/pool.js';
import { runMigrations, migrationsDir } from '../src/db/migrate.js';
import { createApp } from '../src/app.js';

const N = Number(process.argv[2] ?? 8);
if (!Number.isInteger(N) || N < 2 || N > 64) {
  console.error('usage: node scripts/concurrency-proof.mjs [n=2..64]');
  process.exit(1);
}

const cfg = loadConfig({
  ...process.env,
  DATABASE_URL:
    process.env.TEST_DATABASE_URL ??
    (process.env.DATABASE_URL ?? '').replace(/hcm_dev/, 'hcm_test'),
});
const pool = getPool(cfg);

async function main() {
  await runMigrations(pool, migrationsDir);
  const query = pool.query.bind(pool);
  await query(`TRUNCATE appointment_events, calendar_events, notification_log,
    email_queue, post_visit_summaries, visit_notes, pre_visit_summaries,
    appointments, leave_days, doctors, users RESTART IDENTITY CASCADE`);

  const app = createApp({ config: cfg, pool });

  // Seed one doctor (Mon–Fri 09:00–11:00 @20min) directly.
  const dU = (
    await query(
      `INSERT INTO users (role,email,password_hash,name) VALUES ('doctor','proof@t.health','x','Dr Proof') RETURNING id`,
    )
  ).rows[0];
  await query(
    `INSERT INTO doctors (user_id,specialisation,working_days,starts_at,ends_at,slot_minutes)
     VALUES ($1,'General Medicine','{1}','09:00'::time,'11:00'::time,20)`,
    [dU.id],
  );

  // Next Monday in LOCAL calendar terms (computeSlots parses dates locally).
  const target = new Date();
  target.setDate(target.getDate() + (((1 - target.getDay() + 7) % 7) || 7));
  const pad = (v) => String(v).padStart(2, '0');
  const stamp =
    `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())} 09:00`;

  // N distinct patients with forged-but-valid patient sessions.
  const patients = [];
  for (let i = 0; i < N; i += 1) {
    const u = (
      await query(
        `INSERT INTO users (role,email,password_hash,name) VALUES ('patient',$1,'x','P') RETURNING id`,
        [`proof${i}@t.health`],
      )
    ).rows[0];
    patients.push({
      cookie: `hcm_session=${jwt.sign({ sub: String(u.id), role: 'patient' }, cfg.jwtSecret)}`,
    });
  }

  console.log(`firing ${N} parallel holds on ${stamp} …`);
  const results = await Promise.all(
    patients.map((p) =>
      request(app)
        .post(`/api/doctors/${dU.id}/slots/hold`)
        .set('Cookie', p.cookie)
        .send({ scheduledAt: stamp })
        .then((r) => r.status),
    ),
  );

  const ok = results.filter((s) => s === 201).length;
  const taken = results.filter((s) => s === 409).length;
  const live = (
    await query(
      `SELECT count(*)::int AS n FROM appointments
       WHERE status='held' AND scheduled_at = $1::timestamp`,
      [stamp],
    )
  ).rows[0].n;

  const pass = ok === 1 && taken === N - 1 && live === 1;
  console.log(JSON.stringify({ n: N, created: ok, slotTaken: taken, liveHeldRows: live, pass }));
  console.log(pass ? 'PROOF PASSED ✅' : 'PROOF FAILED ❌');

  await pool.end();
  process.exit(pass ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});

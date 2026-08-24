import 'dotenv/config';
import { loadConfig } from '../config.js';
import { getPool } from '../db/pool.js';
import { withTransaction } from '../db/tx.js';
import { hashPassword } from '../lib/passwords.js';
import bcrypt from 'bcryptjs';

const ADMIN = {
  email: process.env.SEED_ADMIN_EMAIL ?? 'admin@ashgrove.health',
  password: process.env.SEED_ADMIN_PASSWORD ?? 'admin-seed-pass-1',
};

const DOCTORS = [
  {
    email: 'meera.mehta@ashgrove.health',
    name: 'Dr. Meera Mehta',
    specialisation: 'General Medicine',
    workingDays: [1, 2, 3, 4, 5],
    startsAt: '09:00',
    endsAt: '13:00',
    slotMinutes: 20,
    password: 'doctor-seed-pass-1',
  },
  {
    email: 'arjun.rao@ashgrove.health',
    name: 'Dr. Arjun Rao',
    specialisation: 'Paediatrics',
    workingDays: [1, 2, 3, 4, 6],
    startsAt: '10:00',
    endsAt: '14:00',
    slotMinutes: 15,
    password: 'doctor-seed-pass-2',
  },
  {
    email: 'fatima.sheikh@ashgrove.health',
    name: 'Dr. Fatima Sheikh',
    specialisation: 'Dermatology',
    workingDays: [2, 4, 6],
    startsAt: '15:00',
    endsAt: '18:00',
    slotMinutes: 30,
    password: 'doctor-seed-pass-3',
  },
];

async function upsertUser(pool, { role, email, name, phone = null, password }) {
  return withTransaction(pool, async (query) => {
    const existing = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rowCount > 0) {
      await query(`UPDATE users SET role = $2 WHERE id = $1`, [existing.rows[0].id, role]);
      return { userId: existing.rows[0].id, created: false };
    }
    const hash = await hashPassword(password);
    const res = await query(
      `INSERT INTO users (role, email, password_hash, name, phone)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [role, email.toLowerCase(), hash, name, phone],
    );
    return { userId: res.rows[0].id, created: true };
  });
}

async function main() {
  const config = loadConfig(process.env);
  const pool = getPool(config);

  const admin = await upsertUser(pool, {
    role: 'admin',
    email: ADMIN.email,
    name: 'Front Desk Admin',
    password: ADMIN.password,
  });
  if (!(await bcrypt.compare(ADMIN.password, (await pool.query('SELECT password_hash FROM users WHERE id=$1', [admin.userId])).rows[0].password_hash))) {
    await pool.query(
      'UPDATE users SET password_hash = $2 WHERE id = $1',
      [admin.userId, await hashPassword(ADMIN.password)],
    );
  }
  console.log(`admin ${ADMIN.email}: ${admin.created ? 'created' : 'exists'}`);

  for (const doc of DOCTORS) {
    const user = await upsertUser(pool, {
      role: 'doctor',
      email: doc.email,
      name: doc.name,
      password: doc.password,
    });
    await pool.query(
      `INSERT INTO doctors (user_id, specialisation, working_days, starts_at, ends_at, slot_minutes)
       VALUES ($1, $2, $3, $4::time, $5::time, $6)
       ON CONFLICT (user_id) DO NOTHING`,
      [user.userId, doc.specialisation, doc.workingDays, doc.startsAt, doc.endsAt, doc.slotMinutes],
    );
    console.log(`doctor ${doc.email}: ${user.created ? 'created' : 'exists'}`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

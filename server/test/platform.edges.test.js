import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadConfig } from '../src/config.js';
import { getPool } from '../src/db/pool.js';
import { runMigrations, migrationsDir } from '../src/db/migrate.js';
import { computeSlots } from '../src/services/slots.service.js';

const config = loadConfig({
  DATABASE_URL: process.env.AGENT_DB_URL ?? 'postgres://postgres:postgres@localhost:5432/hcm_agent_b',
  JWT_SECRET: 'test-jwt-secret-not-for-production',
  JOB_SECRET: 'test-job-secret',
});
const pool = getPool(config);
await runMigrations(pool, migrationsDir);
const query = (t, v) => pool.query(t, v);

const DOCTOR = {
  workingDays: [1, 2, 3, 4, 5],
  startsAt: '09:00',
  endsAt: '11:00', // 120 minutes
  slotMinutes: 20, // → exactly 6 slots
};

beforeAll(async () => {
  await query(
    `TRUNCATE appointment_events, calendar_events, notification_log,
            email_queue, post_visit_summaries, visit_notes,
            pre_visit_summaries, appointments, leave_days, doctors, users
     RESTART IDENTITY CASCADE`,
  );
});

afterAll(async () => {
  await pool.end();
});

describe('computeSlots calendar boundaries (pure UTC-anchored days)', () => {
  it('leap day 2028-02-29 is a Tuesday and slots like any Tuesday', () => {
    const tue = { ...DOCTOR, workingDays: [2] };
    const leap = computeSlots(tue, '2028-02-29');
    expect(leap).toHaveLength(6);
    expect(leap[0].startsAt).toBe('09:00');
    expect(leap.at(-1).startsAt).toBe('10:40');

    // The day before (Feb 28) is a Monday , no slots for a Tuesday-only doctor.
    expect(computeSlots(tue, '2028-02-28')).toHaveLength(0);
  });

  it('year boundary: Thu 2026-12-31 vs Fri 2027-01-01 resolve independently', () => {
    const thu = { ...DOCTOR, workingDays: [4] };
    const fri = { ...DOCTOR, workingDays: [5] };
    expect(computeSlots(thu, '2026-12-31')).toHaveLength(6);
    expect(computeSlots(fri, '2027-01-01')).toHaveLength(6);
    expect(computeSlots(thu, '2027-01-01')).toHaveLength(0);
    expect(computeSlots(fri, '2026-12-31')).toHaveLength(0);
  });

  it('US DST transition Sunday (2026-03-08): naive clinic-local model stays stable', () => {
    const sun = { ...DOCTOR, workingDays: [0] };
    const before = computeSlots(sun, '2026-03-01'); // standard time Sunday
    const during = computeSlots(sun, '2026-03-08'); // DST begins
    const after = computeSlots(sun, '2026-03-15'); // DST in effect
    expect(before).toHaveLength(6);
    expect(during).toEqual(before.map((s) => ({ ...s })));
    expect(after).toEqual(before.map((s) => ({ ...s })));
    expect(during.map((s) => s.startsAt)).toEqual([
      '09:00', '09:20', '09:40', '10:00', '10:20', '10:40',
    ]);
  });

  it('grid alignment: slotMinutes that do not divide the window drop the tail', () => {
    const doc = { ...DOCTOR, slotMinutes: 50 }; // 120min window → 2 full + 20min remainder dropped
    const slots = computeSlots(doc, '2026-08-24');
    expect(slots.map((s) => s.startsAt)).toEqual(['09:00', '09:50']);
  });

  it('nowStr marks past slots; booked/held labels win even for past times', () => {
    const taken = new Map([
      ['09:00', 'booked'],
      ['09:20', 'held'],
    ]);
    const slots = computeSlots(DOCTOR, '2026-08-24', taken, new Set(), '2026-08-24 10:30');
    const byTime = Object.fromEntries(slots.map((s) => [s.startsAt, s.status]));
    expect(byTime['09:00']).toBe('booked'); // historical booking keeps its label
    expect(byTime['09:20']).toBe('held');
    expect(byTime['10:00']).toBe('past'); // <= now
    expect(byTime['10:20']).toBe('past'); // boundary minute is past
    expect(byTime['10:40']).toBe('open'); // future
  });

  it('degenerate inputs all yield [] instead of throwing', () => {
    expect(computeSlots(null, '2026-08-24')).toEqual([]);
    expect(computeSlots(DOCTOR, 'not-a-date')).toEqual([]);
    expect(computeSlots(DOCTOR, '')).toEqual([]);
    expect(computeSlots({ ...DOCTOR, endsAt: '08:00' }, '2026-08-24')).toEqual([]);
    expect(computeSlots({ ...DOCTOR, startsAt: '11:00', endsAt: '09:00' }, '2026-08-24')).toEqual([]);
    expect(computeSlots({ ...DOCTOR, slotMinutes: 0 }, '2026-08-24')).toEqual([]);
    expect(computeSlots({ ...DOCTOR, slotMinutes: -20 }, '2026-08-24')).toEqual([]);
    expect(computeSlots({ ...DOCTOR, slotMinutes: 12.5 }, '2026-08-24')).toEqual([]);
    expect(computeSlots({ ...DOCTOR, workingDays: [] }, '2026-08-24')).toEqual([]);
  });

  it('leave day suppresses the whole date regardless of other inputs', () => {
    expect(computeSlots(DOCTOR, '2026-08-24', new Map(), new Set(['2026-08-24']))).toEqual([]);
  });
});

describe('schema constraints are the double-booking wall', () => {
  let userIds;
  beforeAll(async () => {
    const ids = [];
    for (const email of ['plat.a@x.tld', 'plat.b@x.tld']) {
      const { rows } = await query(
        `INSERT INTO users (role, email, password_hash, name) VALUES ('patient', $1, 'x', 'P') RETURNING id`,
        [email],
      );
      ids.push(rows[0].id);
    }
    const { rows: du } = await query(
      `INSERT INTO users (role, email, password_hash, name) VALUES ('doctor', 'plat.doc@x.tld', 'x', 'D') RETURNING id`,
    );
    await query(`INSERT INTO doctors (user_id, specialisation, starts_at, ends_at, slot_minutes) VALUES ($1, 'General', '09:00', '11:00', 20)`, [du[0].id]);
    userIds = { pa: ids[0], pb: ids[1], doc: du[0].id };
  });

  const insertAppt = (patientId, status, at = '2026-09-07 09:00') =>
    query(
      `INSERT INTO appointments (patient_id, doctor_id, scheduled_at, status) VALUES ($1, $2, $3::timestamp, $4)`,
      [patientId, userIds.doc, at, status],
    );

  it('uniq_appt_doctor_slot blocks two live rows at one moment', async () => {
    await insertAppt(userIds.pa, 'confirmed');
    await expect(insertAppt(userIds.pb, 'held')).rejects.toMatchObject({
      constraint: 'uniq_appt_doctor_slot',
    });
  });

  it('terminal statuses do not consume the slot (partial index semantics)', async () => {
    // Terminal rows pile up freely at the same moment…
    await insertAppt(userIds.pa, 'cancelled_by_patient', '2026-09-07 09:20');
    await insertAppt(userIds.pb, 'expired', '2026-09-07 09:20');
    const { rows } = await query(
      `SELECT count(*)::int n FROM appointments WHERE doctor_id = $1 AND scheduled_at = '2026-09-07 09:20'::timestamp`,
      [userIds.doc],
    );
    expect(rows[0].n).toBe(2);
    // …and the moment is still free for a live row.
    await expect(
      insertAppt(userIds.pb, 'confirmed', '2026-09-07 09:20'),
    ).resolves.toHaveProperty('rowCount', 1);
  });

  it('uniq_appt_patient_hold blocks a second live hold for one patient', async () => {
    const { rows: freshPat } = await query(
      `INSERT INTO users (role, email, password_hash, name) VALUES ('patient', 'plat.c@x.tld', 'x', 'P') RETURNING id`,
    );
    const pid = freshPat[0].id;
    await query(
      `INSERT INTO appointments (patient_id, doctor_id, scheduled_at, status)
       VALUES ($1, $2, '2026-09-08 09:00'::timestamp, 'held')`,
      [pid, userIds.doc],
    );
    await expect(
      query(
        `INSERT INTO appointments (patient_id, doctor_id, scheduled_at, status)
         VALUES ($1, $2, '2026-09-08 10:00'::timestamp, 'held')`,
        [pid, userIds.doc],
      ),
    ).rejects.toMatchObject({ constraint: 'uniq_appt_patient_hold' });
  });

  it('status CHECK rejects unknown lifecycle values; severity CHECK likewise', async () => {
    await expect(
      insertAppt(userIds.pb, 'teleported'),
    ).rejects.toBeTruthy();
    await expect(
      query(
        `INSERT INTO appointments (patient_id, doctor_id, scheduled_at, status, severity)
         VALUES ($1, $2, '2026-09-09 09:00'::timestamp, 'confirmed', 'apocalyptic')`,
        [userIds.pb, userIds.doc],
      ),
    ).rejects.toBeTruthy();
  });

  it('email dedup index: duplicate pending key blocked; failed frees the key', async () => {
    const key = 'platform:dedup:test';
    await query(
      `INSERT INTO email_queue (to_email, template, dedup_key) VALUES ('a@x.tld', 'booking_confirmation', $1)`,
      [key],
    );
    await expect(
      query(
        `INSERT INTO email_queue (to_email, template, dedup_key) VALUES ('b@x.tld', 'booking_confirmation', $1)`,
        [key],
      ),
    ).rejects.toMatchObject({ constraint: 'uniq_email_dedup' });

    await query(`UPDATE email_queue SET status = 'failed' WHERE dedup_key = $1`, [key]);
    await expect(
      query(
        `INSERT INTO email_queue (to_email, template, dedup_key) VALUES ('c@x.tld', 'booking_confirmation', $1)`,
        [key],
      ),
    ).resolves.toHaveProperty('rowCount', 1);
  });

  it('calendar_events UNIQUE(appointment_id, audience) + audience CHECK hold', async () => {
    const appt = await insertAppt(userIds.pb, 'confirmed', '2026-09-10 09:00');
    void appt;
    const { rows: idRow } = await query(
      `SELECT id FROM appointments WHERE patient_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [userIds.pb],
    );
    const id = idRow[0].id;
    await query(`INSERT INTO calendar_events (appointment_id, audience) VALUES ($1, 'patient')`, [id]);
    await expect(
      query(`INSERT INTO calendar_events (appointment_id, audience) VALUES ($1, 'patient')`, [id]),
    ).rejects.toBeTruthy();
    await expect(
      query(`INSERT INTO calendar_events (appointment_id, audience) VALUES ($1, 'gp')`, [id]),
    ).rejects.toBeTruthy();
  });

  it('FK graph: deleting a doctor user cascades the doctors row; patient with appointments is protected', async () => {
    // Fresh disposable doctor.
    const { rows: du } = await query(
      `INSERT INTO users (role, email, password_hash, name) VALUES ('doctor', 'plat.del@x.tld', 'x', 'D2') RETURNING id`,
    );
    await query(`INSERT INTO doctors (user_id, specialisation, starts_at, ends_at, slot_minutes) VALUES ($1, 'X', '09:00', '11:00', 20)`, [du[0].id]);

    const { rows: pat } = await query(
      `INSERT INTO users (role, email, password_hash, name) VALUES ('patient', 'plat.protected@x.tld', 'x', 'P') RETURNING id`,
    );
    await query(
      `INSERT INTO appointments (patient_id, doctor_id, scheduled_at, status)
       VALUES ($1, $2, '2026-09-11 09:00'::timestamp, 'confirmed')`,
      [pat[0].id, du[0].id],
    );

    // Doctor user delete cascades doctors row… but appointments reference it without cascade:
    // decide actual behavior from the schema , appointments.doctor_id has no ON DELETE,
    // so Postgres RESTRICTS while any appointment points there.
    await expect(query(`DELETE FROM users WHERE id = $1`, [du[0].id])).rejects.toBeTruthy();

    // Patient with history is equally protected (no ON DELETE on patient_id).
    await expect(query(`DELETE FROM users WHERE id = $1`, [pat[0].id])).rejects.toBeTruthy();

    // A doctor user WITHOUT appointments deletes cleanly and takes the doctors row along.
    const { rows: du2 } = await query(
      `INSERT INTO users (role, email, password_hash, name) VALUES ('doctor', 'plat.free@x.tld', 'x', 'D3') RETURNING id`,
    );
    await query(`INSERT INTO doctors (user_id, specialisation, starts_at, ends_at, slot_minutes) VALUES ($1, 'Y', '09:00', '11:00', 20)`, [du2[0].id]);
    await expect(query(`DELETE FROM users WHERE id = $1`, [du2[0].id])).resolves.toHaveProperty('rowCount', 1);
    const leftover = await query(`SELECT count(*)::int n FROM doctors WHERE user_id = $1`, [du2[0].id]);
    expect(leftover.rows[0].n).toBe(0);
  });
});

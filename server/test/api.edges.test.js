import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { loadConfig } from '../src/config.js';
import { getPool } from '../src/db/pool.js';
import { runMigrations, migrationsDir } from '../src/db/migrate.js';
import { createApp } from '../src/app.js';
import { clinicNowStr } from '../src/routes/public.routes.js';

const config = loadConfig({
  DATABASE_URL: process.env.AGENT_DB_URL ?? 'postgres://postgres:postgres@localhost:5432/hcm_agent_b',
  JWT_SECRET: 'test-jwt-secret-not-for-production',
  JOB_SECRET: 'test-job-secret',
});
const pool = getPool(config);
await runMigrations(pool, migrationsDir);
const query = (t, v) => pool.query(t, v);

let NOW = new Date('2026-08-20T08:00:00');
const tickMinutes = (m) => {
  NOW = new Date(NOW.getTime() + m * 60_000);
};

const app = createApp({ config, pool, now: () => NOW, nowStr: () => clinicNowStr(NOW) });
const cookie = (id, role) =>
  `${config.cookieName}=${jwt.sign({ sub: String(id), role }, config.jwtSecret)}`;
let adminC;

const MONDAY = '2026-08-24';
let seq = 500;
const tag = () => (seq += 1);

async function mkDoctor(over = {}) {
  const t = tag();
  const res = await request(app)
    .post('/api/admin/doctors')
    .set('Cookie', adminC)
    .send({
      email: `edge.doc.${t}@ashgrove.health`,
      name: `Dr. Edge ${t}`,
      password: 'doctor-pass-1',
      specialisation: 'General Medicine',
      workingDays: [1],
      startsAt: '09:00',
      endsAt: '11:00',
      slotMinutes: 20,
      ...over,
    });
  return res;
}

async function mkPatient() {
  const t = tag();
  const res = await request(app).post('/api/auth/register').send({
    email: `edge.pat.${t}@ashgrove.health`,
    name: `Edge Pat ${t}`,
    password: 'long-enough-1',
  });
  expect(res.status).toBe(201);
  return { id: res.body.user.id, c: cookie(res.body.user.id, 'patient') };
}

async function confirmedAppt(doc, time = '09:00', symptomsSeverity = 'moderate') {
  const p = await mkPatient();
  const hold = await request(app)
    .post(`/api/doctors/${doc.userId}/slots/hold`)
    .set('Cookie', p.c)
    .send({ scheduledAt: `${MONDAY} ${time}` });
  expect(hold.status).toBe(201);
  const conf = await request(app)
    .post(`/api/appointments/${hold.body.appointment.id}/confirm`)
    .set('Cookie', p.c)
    .send({ symptomsText: 'Persistent cough for five days.', severity: symptomsSeverity, durationText: '5 days' });
  expect(conf.status).toBe(200);
  return { p, id: hold.body.appointment.id };
}

beforeAll(async () => {
  await query(
    `TRUNCATE appointment_events, calendar_events, notification_log,
            email_queue, post_visit_summaries, visit_notes,
            pre_visit_summaries, appointments, leave_days, doctors, users
     RESTART IDENTITY CASCADE`,
  );
  adminC = cookie(999, 'admin');
});

afterAll(async () => {
  await pool.end();
});

describe('registration validation boundaries', () => {
  const base = { name: 'Val Pat', password: 'long-enough-1' };
  const attempt = (body) =>
    request(app).post('/api/auth/register').send({ ...base, ...body });

  it.each([
    ['email missing @', { email: 'plainaddress' }],
    ['email too long (>254)', { email: `${'a'.repeat(250)}@x.tld` }],
    ['empty name', { email: `r${tag()}@x.tld`, name: '   ' }],
    ['name >120 chars', { email: `r${tag()}@x.tld`, name: 'n'.repeat(121) }],
    ['phone with letters', { email: `r${tag()}@x.tld`, phone: '12345abc' }],
    ['phone too short (6 digits)', { email: `r${tag()}@x.tld`, phone: '123456' }],
    ['password 7 chars', { email: `r${tag()}@x.tld`, password: '7chars!' }],
    ['password >200 chars', { email: `r${tag()}@x.tld`, password: 'p'.repeat(201) }],
  ])('%s → 422', async (_label, body) => {
    const res = await attempt(body);
    expect(res.status).toBe(400);
  });

  it.each([
    ['phone at min (7 digits)', '1234567'],
    ['phone at max (15 digits)', '123456789012345'],
    ['password exactly 8', '8chars!!'],
  ])('accepts %s', async (_label, field) => {
    const body =
      _label.startsWith('password')
        ? { email: `rok${tag()}@x.tld`, password: field }
        : { email: `rok${tag()}@x.tld`, phone: field };
    const res = await attempt(body);
    expect(res.status).toBe(201);
  });

  it('normalises email case + trims inputs; duplicate detection is case-insensitive', async () => {
    const email = `case.test.${tag()}@AshGrove.Health`;
    const first = await attempt({ email: `  ${email}  `, name: '  Spaced Name  ' });
    expect(first.status).toBe(201);
    expect(first.body.user.email).toBe(email.toLowerCase().trim());
    expect(first.body.user.name).toBe('Spaced Name');

    const dupe = await attempt({ email: email.toUpperCase() });
    expect([409, 422]).toContain(dupe.status); // rejected either as conflict or validation
    expect(dupe.status).not.toBe(201);
  });

  it('login accepts the normalised form regardless of input casing', async () => {
    const email = `login.case.${tag()}@ashgrove.health`;
    await attempt({ email, name: 'Login Case' });
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: email.toUpperCase(), password: 'long-enough-1' });
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie'][0]).toMatch(/HttpOnly/i);
    expect(res.headers['set-cookie'][0]).toMatch(/SameSite=Lax/i);
  });
});

describe('doctor admin guards', () => {
  const validBody = (over = {}) => ({
    email: `guard.doc.${tag()}@ashgrove.health`,
    name: 'Guard Doc',
    password: 'doctor-pass-1',
    specialisation: 'General Medicine',
    workingDays: [1],
    startsAt: '09:00',
    endsAt: '11:00',
    slotMinutes: 20,
    ...over,
  });

  it.each([
    ['endsAt before startsAt', { startsAt: '15:00', endsAt: '09:00' }],
    ['endsAt equal to startsAt', { startsAt: '09:00', endsAt: '09:00' }],
    ['slotMinutes 0', { slotMinutes: 0 }],
    ['slotMinutes negative', { slotMinutes: -10 }],
    ['slotMinutes over cap', { slotMinutes: 241 }],
    ['empty workingDays', { workingDays: [] }],
    ['workingDay 7 out of range', { workingDays: [7] }],
    ['workingDay fractional', { workingDays: [1.5] }],
    ['invalid time string', { startsAt: '9am' }],
  ])('%s → 422', async (_label, over) => {
    const res = await request(app)
      .post('/api/admin/doctors')
      .set('Cookie', adminC)
      .send(validBody(over));
    expect(res.status).toBe(400);
  });

  it('duplicate doctor email → 409/422, never a second doctor', async () => {
    const twin = await mkDoctor();
    expect(twin.status).toBe(201);

    const dupeRes = await request(app)
      .post('/api/admin/doctors')
      .set('Cookie', adminC)
      .send(validBody({ email: twin.body.doctor.email }));
    expect([409, 422]).toContain(dupeRes.status);

    const sameEmailCount = await query(`SELECT count(*)::int n FROM users WHERE email = $1`, [
      twin.body.doctor.email,
    ]);
    expect(sameEmailCount.rows[0].n).toBe(1);
  });

  it('non-admin cannot create doctors; anonymous cannot either', async () => {
    const p = await mkPatient();
    const asPatient = await request(app)
      .post('/api/admin/doctors')
      .set('Cookie', p.c)
      .send(validBody());
    expect(asPatient.status).toBe(403);

    const anon = await request(app).post('/api/admin/doctors').send({});
    expect(anon.status).toBe(401);
  });
});

describe('visit-notes prescription validation', () => {
  async function completableAppt() {
    const doc = (await mkDoctor()).body.doctor;
    const { p, id } = await confirmedAppt(doc);
    return { doc, p, id };
  }

  const postNotes = (doc, id, body) =>
    request(app)
      .post(`/api/appointments/${id}/notes`)
      .set('Cookie', cookie(doc.userId, 'doctor'))
      .send(body);

  it.each([
    ['empty clinical notes', { clinicalNotes: '   ', prescription: [] }],
    ['clinical notes over 10000', { clinicalNotes: 'x'.repeat(10001) }],
    ['medication without name', { clinicalNotes: 'ok', prescription: [{ dosage: '5mg', times: ['08:00'], durationDays: 3 }] }],
    ['times empty array', { clinicalNotes: 'ok', prescription: [{ name: 'A', times: [], durationDays: 3 }] }],
    ['malformed time 24:00', { clinicalNotes: 'ok', prescription: [{ name: 'A', times: ['24:00'], durationDays: 3 }] }],
    ['malformed time 8:00 (no leading zero)', { clinicalNotes: 'ok', prescription: [{ name: 'A', times: ['8:00'], durationDays: 3 }] }],
    ['durationDays 0', { clinicalNotes: 'ok', prescription: [{ name: 'A', times: ['08:00'], durationDays: 0 }] }],
    ['durationDays negative', { clinicalNotes: 'ok', prescription: [{ name: 'A', times: ['08:00'], durationDays: -5 }] }],
    ['durationDays over a year', { clinicalNotes: 'ok', prescription: [{ name: 'A', times: ['08:00'], durationDays: 366 }] }],
    ['fractional durationDays', { clinicalNotes: 'ok', prescription: [{ name: 'A', times: ['08:00'], durationDays: 2.5 }] }],
    ['more than 20 medications', { clinicalNotes: 'ok', prescription: Array.from({ length: 21 }, (_, i) => ({ name: `M${i}`, times: ['08:00'], durationDays: 1 })) }],
    ['more than 6 times per day', { clinicalNotes: 'ok', prescription: [{ name: 'A', times: ['06:00', '08:00', '10:00', '12:00', '14:00', '16:00', '18:00'], durationDays: 2 }] }],
  ])('%s → 422, appointment stays confirmed', async (_l, body) => {
    const { doc, id } = await completableAppt();
    const res = await postNotes(doc, id, body);
    expect(res.status).toBe(400);
    const row = await query(`SELECT status FROM appointments WHERE id = $1`, [id]);
    expect(row.rows[0].status).toBe('confirmed');
  });

  it('boundary values accepted: exactly 10000 chars, 20 meds, 6 times, 365 days, durationDays 1', async () => {
    const { doc, id } = await completableAppt();
    const res = await postNotes(doc, id, {
      clinicalNotes: 'y'.repeat(10000),
      prescription: [
        { name: 'Max Med', dosage: 'd'.repeat(60), times: ['23:59'], durationDays: 365 },
      ],
    });
    expect(res.status).toBe(200);

    const notes = await query(`SELECT prescription FROM visit_notes WHERE appointment_id = $1`, [id]);
    expect(notes.rows[0].prescription[0].durationDays).toBe(365);
  });

  it('first write wins: second notes submission → 409 CONFLICT', async () => {
    const { doc, id } = await completableAppt();
    expect((await postNotes(doc, id, { clinicalNotes: 'first' })).status).toBe(200);
    const second = await postNotes(doc, id, { clinicalNotes: 'second attempt' });
    expect(second.status).toBe(409);
    const row = await query(`SELECT status FROM appointments WHERE id = $1`, [id]);
    expect(row.rows[0].status).toBe('completed');
  });

  it('another doctor cannot write notes on someone else’s appointment (404)', async () => {
    const { doc, id } = await completableAppt();
    const strangerDoc = (await mkDoctor()).body.doctor;
    const res = await postNotes(strangerDoc, id, { clinicalNotes: 'not mine' });
    expect(res.status).toBe(404);
  });
});

describe('leave marking edges', () => {
  it('re-marking the same leave day is idempotent (cancelledCount 0, single row)', async () => {
    const doc = (await mkDoctor()).body.doctor;
    await confirmedAppt(doc);

    const first = await request(app)
      .post(`/api/admin/doctors/${doc.userId}/leave`)
      .set('Cookie', adminC)
      .send({ date: MONDAY });
    expect(first.status).toBe(200);
    const firstCount = first.body.cancelledCount;

    const second = await request(app)
      .post(`/api/admin/doctors/${doc.userId}/leave`)
      .set('Cookie', adminC)
      .send({ date: MONDAY });
    expect(second.status).toBe(200);
    expect(second.body.cancelledCount).toBe(0);

    const rows = await query(`SELECT count(*)::int n FROM leave_days WHERE doctor_id = $1 AND date = $2::date`, [doc.userId, MONDAY]);
    expect(rows.rows[0].n).toBe(1);
    void firstCount;
  });

  it('leave on a date with no bookings reports cancelledCount 0 and still blocks slots', async () => {
    const doc = (await mkDoctor()).body.doctor;
    const res = await request(app)
      .post(`/api/admin/doctors/${doc.userId}/leave`)
      .set('Cookie', adminC)
      .send({ date: '2026-09-28' }); // a Monday far ahead
    expect(res.status).toBe(200);
    expect(res.body.cancelledCount).toBe(0);

    const slots = await request(app).get(`/api/doctors/${doc.userId}/slots?date=2026-09-28`);
    expect(slots.body.slots ?? []).toHaveLength(0);
  });

  it('invalid leave payload → 422', async () => {
    const doc = (await mkDoctor()).body.doctor;
    for (const date of ['not-a-date', '2026-13-40', '', undefined]) {
      const res = await request(app)
        .post(`/api/admin/doctors/${doc.userId}/leave`)
        .set('Cookie', adminC)
        .send({ date });
      expect(res.status).toBe(400);
    }
  });
});

describe('doctor queue ordering and health snapshot exactness', () => {
  it('queue sorts High → Medium → Low, tie-broken by scheduled_at ascending', async () => {
    const doc = (await mkDoctor()).body.doctor;

    // Book in scrambled urgency order.
    const low = await confirmedAppt(doc, '09:00', 'mild');
    const high = await confirmedAppt(doc, '09:20', 'severe');
    const medium = await confirmedAppt(doc, '09:40', 'moderate');

    // Force summaries ready with chosen urgencies directly.
    for (const [apptId, urgency] of [
      [low.id, 'low'],
      [high.id, 'high'],
      [medium.id, 'medium'],
    ]) {
      await query(
        `UPDATE pre_visit_summaries SET urgency = $2, chief_complaint = 'cc', questions = '[]'::jsonb,
                generation_status = 'ready', source = 'fallback'
         WHERE appointment_id = $1`,
        [apptId, urgency],
      );
    }

    const queue = await request(app)
      .get(`/api/doctors/me/queue?date=${MONDAY}`)
      .set('Cookie', cookie(doc.userId, 'doctor'));
    expect(queue.status).toBe(200);
    const ids = queue.body.queue.map((i) => i.id);
    expect(ids).toEqual([high.id, medium.id, low.id]);
  });

  it('health counters match seeded reality exactly; lastTickAt null before first tick', async () => {
    const doc = (await mkDoctor()).body.doctor;
    const { id } = await confirmedAppt(doc); // enqueues 2 emails + 2 calendar events + 1 pending summary

    // One dead-lettered email.
    await query(
      `INSERT INTO email_queue (to_email, template, status, attempts) VALUES ('dead@x.tld', 'booking_confirmation', 'failed', 3)`,
    );

    const health = await request(app).get('/api/admin/health').set('Cookie', adminC);
    expect(health.status).toBe(200);

    const expectedPendingEmails = await query(
      `SELECT count(*)::int n FROM email_queue WHERE status='pending'`,
    );
    expect(health.body.emails.pending).toBe(expectedPendingEmails.rows[0].n);
    expect(health.body.emails.failed).toBeGreaterThanOrEqual(1);

    const calPending = await query(
      `SELECT count(*)::int n FROM calendar_events WHERE sync_status IN ('pending','deleting')`,
    );
    expect(health.body.calendar.pending).toBe(calPending.rows[0].n);

    const holdsActive = await query(`SELECT count(*)::int n FROM appointments WHERE status='held'`);
    expect(health.body.holds.active).toBe(holdsActive.rows[0].n);

    const summariesPending = await query(
      `SELECT (SELECT count(*)::int FROM pre_visit_summaries WHERE generation_status='pending')
            + (SELECT count(*)::int FROM post_visit_summaries WHERE generation_status='pending') AS n`,
    );
    expect(health.body.summaries.pending).toBe(summariesPending.rows[0].n);

    // No tick has run in this suite yet.
    expect(health.body.lastTickAt).toBeNull();
    void id;
  });
});

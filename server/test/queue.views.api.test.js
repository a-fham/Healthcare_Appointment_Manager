import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { hashPassword } from '../src/lib/passwords.js';
import {
  testConfig,
  getTestPool,
  resetDb,
  closeTestPool,
} from './helpers.js';
import { createApp } from '../src/app.js';

const cfg = testConfig();
const pool = await getTestPool();
const app = createApp({ config: cfg, pool });
const query = (t, v) => pool.query(t, v);

afterAll(closeTestPool);

const DATE = '2026-08-28';
let q2docCookie;
let queuedocCookie;
let patientCookie;

async function mkUser(role, email) {
  const hash = await hashPassword('Passw0rd!123');
  return (
    await query(
      `INSERT INTO users (role,email,password_hash,name) VALUES ($1,$2,$3,'T') RETURNING id`,
      [role, email, hash],
    )
  ).rows[0].id;
}

async function mkDoctorProfile(userId) {
  await query(
    `INSERT INTO doctors (user_id, specialisation, working_days, starts_at, ends_at, slot_minutes)
     VALUES ($1,'Gen','{1}','09:00'::time,'17:00'::time,30)`,
    [userId],
  );
}

async function login(email) {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ email, password: 'Passw0rd!123' });
  return res.headers['set-cookie'];
}

async function mkAppt({ patientId, doctorId, stamp, status = 'confirmed', urgency = null }) {
  const a = await query(
    `INSERT INTO appointments (patient_id, doctor_id, scheduled_at, status, symptoms_text, severity, duration_text)
     VALUES ($1,$2,$3::timestamp,$4,'sx','mild','d') RETURNING id`,
    [patientId, doctorId, stamp, status],
  );
  const apptId = a.rows[0].id;
  if (urgency) {
    await query(
      `INSERT INTO pre_visit_summaries (appointment_id, urgency, chief_complaint, questions, generation_status)
       VALUES ($1,$2,'cc','["q1","q2","q3"]','ready')`,
      [apptId, urgency],
    );
  }
  return apptId;
}

beforeAll(async () => {
  await resetDb();

  // Doctor whose queue exercises sorting.
  const q2doc = await mkUser('doctor', 'q2doc@t.health');
  await mkDoctorProfile(q2doc);
  q2docCookie = await login('q2doc@t.health');

  const p1 = await mkUser('patient', 'q2p1@t.health');
  const p2 = await mkUser('patient', 'q2p2@t.health');
  const p3 = await mkUser('patient', 'q2p3@t.health');
  const p4 = await mkUser('patient', 'q2p4@t.health');
  const p5 = await mkUser('patient', 'q2p5@t.health');

  await mkAppt({ patientId: p1, doctorId: q2doc, stamp: `${DATE} 11:00`, urgency: 'medium' });
  await mkAppt({ patientId: p2, doctorId: q2doc, stamp: `${DATE} 10:00`, urgency: 'high' });
  await mkAppt({ patientId: p3, doctorId: q2doc, stamp: `${DATE} 09:00`, urgency: 'low' });
  await mkAppt({ patientId: p4, doctorId: q2doc, stamp: `${DATE} 09:20`, urgency: 'high' });
  await mkAppt({
    patientId: p5, doctorId: q2doc, stamp: `${DATE} 12:00`,
    status: 'completed', urgency: 'high',
  });
  await mkAppt({
    patientId: p4, doctorId: q2doc, stamp: `${DATE} 13:00`,
    status: 'cancelled_by_patient', urgency: 'high',
  });

  // Doctors exercising scoping rules.
  const queuedoc = await mkUser('doctor', 'queuedoc@t.health');
  await mkDoctorProfile(queuedoc);
  queuedocCookie = await login('queuedoc@t.health');

  const qp = await mkUser('patient', 'qp-main@t.health');
  await mkAppt({ patientId: qp, doctorId: queuedoc, stamp: `${DATE} 15:00`, urgency: 'low' });

  const otherdoc = await mkUser('doctor', 'queueother@t.health');
  await mkDoctorProfile(otherdoc);

  const op = await mkUser('patient', 'qp-other@t.health');
  await mkAppt({ patientId: op, doctorId: otherdoc, stamp: `${DATE} 16:00`, urgency: 'high' });

  // Plain patient for role-gate checks.
  patientCookie = await login(await mkPatientLogin());
});

async function mkPatientLogin() {
  const id = await mkUser('patient', 'plainpat@t.health');
  void id;
  return 'plainpat@t.health';
}

describe('GET /api/doctors/me/queue', () => {
  it('sorts by urgency (high→medium→low) then time; completed stays visible; cancellations hidden', async () => {
    const res = await request(app)
      .get('/api/doctors/me/queue')
      .query({ date: DATE })
      .set('Cookie', q2docCookie);
    expect(res.status).toBe(200);
    expect(res.body.date).toBe(DATE);
    expect(res.body.queue.map((r) => r.urgency)).toEqual(['high', 'high', 'high', 'medium', 'low']);
    expect(res.body.queue[0].scheduledAt).toContain('09:20');
    expect(res.body.queue[2].scheduledAt).toContain('12:00');
    expect(res.body.queue[0].chiefComplaint).toBe('cc');
    expect(res.body.queue[0].questions).toEqual(['q1', 'q2', 'q3']);
    expect(JSON.stringify(res.body.queue)).not.toContain('symptoms_text');
    expect(JSON.stringify(res.body.queue)).not.toContain('clinical_notes');
  });

  it('scopes strictly to the owning doctor; bad date 400; patient role 403', async () => {
    const res = await request(app)
      .get('/api/doctors/me/queue')
      .query({ date: DATE })
      .set('Cookie', queuedocCookie);
    expect(res.status).toBe(200);
    expect(res.body.queue).toHaveLength(1);
    expect(res.body.queue[0].urgency).toBe('low');

    const bad = await request(app)
      .get('/api/doctors/me/queue')
      .query({ date: 'junk' })
      .set('Cookie', queuedocCookie);
    expect(bad.status).toBe(400);

    const asPatient = await request(app)
      .get('/api/doctors/me/queue')
      .query({ date: DATE })
      .set('Cookie', patientCookie);
    expect(asPatient.status).toBe(403);
  });

  it('defaults to today when no date given (200, array)', async () => {
    const res = await request(app)
      .get('/api/doctors/me/queue')
      .set('Cookie', queuedocCookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.queue)).toBe(true);
  });
});

describe('GET /api/my/appointments', () => {
  it('own appointments newest-first; ready post-visit summary exposed; pending → null; no triage leakage', async () => {
    const pat = await mkUser('patient', 'minepat@t.health');
    const doc = await mkUser('doctor', 'minedoc@t.health');
    await mkDoctorProfile(doc);
    void doc;

    const older = (
      await query(
        `INSERT INTO appointments (patient_id, doctor_id, scheduled_at, status, symptoms_text, severity, duration_text)
         VALUES ($1,(SELECT id FROM users WHERE email='minedoc@t.health'),'2026-08-20 09:00','completed','sx','mild','d')
         RETURNING id`,
        [pat],
      )
    ).rows[0].id;
    const newer = (
      await query(
        `INSERT INTO appointments (patient_id, doctor_id, scheduled_at, status, symptoms_text, severity, duration_text)
         VALUES ($1,(SELECT id FROM users WHERE email='minedoc@t.health'),'2026-08-30 09:00','confirmed','sx','mild','d')
         RETURNING id`,
        [pat],
      )
    ).rows[0].id;

    await query(
      `INSERT INTO visit_notes (appointment_id, clinical_notes, prescription) VALUES ($1,'notes','[]')`,
      [older],
    );
    await query(
      `INSERT INTO post_visit_summaries (appointment_id, summary_md, medication_schedule, follow_up, generation_status, source)
       VALUES ($1,'# Rest up','[]','Drink water.','ready','fallback')`,
      [older],
    );
    await query(`INSERT INTO post_visit_summaries (appointment_id, generation_status) VALUES ($1,'pending')`, [newer]);

    const someoneElse = await mkUser('patient', 'mineother@t.health');
    await query(
      `INSERT INTO appointments (patient_id, doctor_id, scheduled_at, status)
       VALUES ($1,(SELECT id FROM users WHERE email='minedoc@t.health'),'2026-08-21 09:00','confirmed')`,
      [someoneElse],
    );

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'minepat@t.health', password: 'Passw0rd!123' });
    const res = await request(app).get('/api/my/appointments').set('Cookie', loginRes.headers['set-cookie']);

    expect(res.status).toBe(200);
    expect(res.body.appointments.map((a) => a.id)).toEqual([newer, older]);

    const done = res.body.appointments.find((a) => a.id === older);
    expect(done.postVisit.summaryMd).toContain('Rest up');
    expect(done.postVisit.followUp).toContain('water');
    const doneJson = JSON.stringify(done);
    expect(doneJson).not.toContain('urgency');
    expect(doneJson).not.toContain('questions');
    expect(doneJson).not.toContain('clinical_notes');

    const pending = res.body.appointments.find((a) => a.id === newer);
    expect(pending.postVisit).toBeNull();

    // Strangers' rows never appear.
    expect(res.body.appointments).toHaveLength(2);
  });

  it('doctors get 403 on the patient endpoint', async () => {
    const res = await request(app).get('/api/my/appointments').set('Cookie', queuedocCookie);
    expect(res.status).toBe(403);
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import {
  testConfig,
  getTestPool,
  resetDb,
  closeTestPool,
} from './helpers.js';
import { createApp } from '../src/app.js';
import { processEmails } from '../src/services/workers/email.worker.js';
import { processCalendarEvents } from '../src/services/workers/calendar.worker.js';
import { expireHolds } from '../src/services/workers/hold.sweeper.js';
import { scheduleMedicationReminders } from '../src/services/workers/reminders.js';

const pool = await getTestPool();
const query = (t, v) => pool.query(t, v);
const cfg = testConfig();
const app = createApp({ config: cfg, pool });

afterAll(closeTestPool);

const NOW = new Date('2026-08-24T09:00:00');
const plus = (min) => new Date(NOW.getTime() + min * 60_000);

async function seedEmail({ status = 'pending', attempts = 0, dueMinAgo = 1, dedup = null }) {
  const { rows } = await query(
    `INSERT INTO email_queue (to_email, template, payload, status, attempts, next_attempt_at, dedup_key)
     VALUES ('x@t.health','booking_confirmation','{}',$1,$2,$3,$4) RETURNING id`,
    [status, attempts, plus(-dueMinAgo), dedup],
  );
  return rows[0].id;
}

async function seedCalRow({ sync = 'pending', geid = null, attempts = 0 }) {
  const u = await query(
    `INSERT INTO users (role,email,password_hash,name) VALUES ('patient', $1,'x','P') RETURNING id`,
    [`w${Date.now()}${Math.floor(Math.random() * 1e9)}@t.health`],
  );
  const dU = await query(
    `INSERT INTO users (role,email,password_hash,name) VALUES ('doctor', $1,'x','D') RETURNING id`,
    [`wd${Date.now()}${Math.floor(Math.random() * 1e9)}@t.health`],
  );
  await query(
    `INSERT INTO doctors (user_id,specialisation,working_days,starts_at,ends_at,slot_minutes)
     VALUES ($1,'Gen','{1}','09:00'::time,'17:00'::time,30)`,
    [dU.rows[0].id],
  );
  const a = await query(
    `INSERT INTO appointments (patient_id, doctor_id, scheduled_at, status)
     VALUES ($1,$2,'2026-08-25 09:00','confirmed') RETURNING id`,
    [u.rows[0].id, dU.rows[0].id],
  );
  const c = await query(
    `INSERT INTO calendar_events (appointment_id, audience, sync_status, google_event_id, attempts)
     VALUES ($1,'patient',$2,$3,$4) RETURNING id`,
    [a.rows[0].id, sync, geid, attempts],
  );
  return { calId: c.rows[0].id, apptId: a.rows[0].id };
}

beforeAll(async () => {
  await resetDb();
});

describe('email worker', () => {
  it('sends due pending mail, stamps sent_at; ignores future rows', async () => {
    const due = await seedEmail({ dueMinAgo: 5 });
    const future = await seedEmail({ dueMinAgo: -30 });

    const sent = [];
    const r = await processEmails({
      query,
      now: () => NOW,
      sendEmail: async (m) => { sent.push(m.to); },
    });

    expect(r.sent).toBe(1);
    expect(sent).toEqual(['x@t.health']);
    const row = (await query(`SELECT * FROM email_queue WHERE id=$1`, [due])).rows[0];
    expect(row.status).toBe('sent');
    expect(row.sent_at).toBeTruthy();
    const untouched = (await query(`SELECT * FROM email_queue WHERE id=$1`, [future])).rows[0];
    expect(untouched.status).toBe('pending');
  });

  it('retries with escalating backoff on transient failure, then dead-letters on strike three', async () => {
    const flaky = await seedEmail({ attempts: 2 }); // one strike left
    let calls = 0;
    const r = await processEmails({
      query,
      now: () => NOW,
      sendEmail: async () => { calls += 1; throw new Error('smtp down'); },
    });
    expect(r.failed).toBe(1);
    expect(calls).toBe(1);
    const row = (await query(`SELECT * FROM email_queue WHERE id=$1`, [flaky])).rows[0];
    expect(row.status).toBe('failed');
    expect(row.last_error).toContain('smtp down');

    // Backoff path from a fresh failure:
    const retrying = await seedEmail({ attempts: 0 });
    let failOnce = true;
    await processEmails({
      query,
      now: () => NOW,
      sendEmail: async () => { if (failOnce) { failOnce = false; throw new Error('blip'); } },
    });
    const mid = (await query(`SELECT * FROM email_queue WHERE id=$1`, [retrying])).rows[0];
    expect(mid.status).toBe('pending');
    expect(mid.attempts).toBe(1);
    expect(new Date(mid.next_attempt_at).getTime()).toBeGreaterThan(plus(0).getTime());
  });

  it('dead-letter frees the dedup key (a re-enqueue can start fresh)', async () => {
    await seedEmail({ status: 'failed', dedup: 'confirm:dead:patient' });
    await query(
      `INSERT INTO email_queue (to_email, template, payload, dedup_key)
       VALUES ('x@t.health','booking_confirmation','{}','confirm:dead:patient')`,
    );
    const n = (
      await query(`SELECT count(*)::int AS n FROM email_queue WHERE dedup_key='confirm:dead:patient'`)
    ).rows[0].n;
    expect(n).toBe(2); // failed row + fresh live row coexist
  });

  it('pool-backed drain runs claim+marking in one tx while keeping per-row isolation', async () => {
    await resetDb();
    const okRow = await seedEmail({});
    await seedEmail({ attempts: 2 }); // strike three on this run
    let n = 0;
    const r = await processEmails({
      query,
      pool,
      now: () => NOW,
      sendEmail: async () => { n += 1; if (n === 2) throw new Error('smtp down'); },
    });
    expect(r.attempted).toBe(2);
    expect(r.sent).toBe(1);
    expect(r.failed).toBe(1);
    const sentRow = (
      await query(`SELECT status, sent_at FROM email_queue WHERE id=$1`, [okRow])
    ).rows[0];
    expect(sentRow.status).toBe('sent');
    expect(sentRow.sent_at).toBeTruthy();
  });
});

describe('calendar worker', () => {
  it('creates pending events → synced with google id; deleting rows → deleted', async () => {
    const created = [];
    const a = await seedCalRow({ sync: 'pending' });
    const b = await seedCalRow({ sync: 'deleting', geid: 'g-123' });

    const fakeCal = {
      createEvent: async ({ appointmentId, audience }) => {
        created.push(`${appointmentId}:${audience}`);
        return { googleEventId: `ge-${created.length}` };
      },
      deleteEvent: async () => {},
    };

    const r = await processCalendarEvents({ query, now: () => NOW, cal: fakeCal });
    expect(r.synced).toBeGreaterThanOrEqual(1);
    expect(r.deleted).toBe(1);
    expect(created.length).toBeGreaterThanOrEqual(1);

    const ra = (await query(`SELECT * FROM calendar_events WHERE id=$1`, [a.calId])).rows[0];
    expect(ra.sync_status).toBe('synced');
    expect(ra.google_event_id).toMatch(/^ge-/);
    const rb = (await query(`SELECT * FROM calendar_events WHERE id=$1`, [b.calId])).rows[0];
    expect(rb.sync_status).toBe('deleted');
  });

  it('failures keep rows pending with backoff; strike three dead-letters to failed', async () => {
    const doomed = await seedCalRow({ sync: 'pending', attempts: 2 });
    const r = await processCalendarEvents({
      query,
      now: () => NOW,
      cal: { createEvent: async () => { throw new Error('google 500'); }, deleteEvent: async () => {} },
    });
    expect(r.failed).toBe(1);
    const row = (await query(`SELECT * FROM calendar_events WHERE id=$1`, [doomed.calId])).rows[0];
    expect(row.sync_status).toBe('failed');

    const softFail = await seedCalRow({ sync: 'pending', attempts: 0 });
    let once = true;
    await processCalendarEvents({
      query,
      now: () => NOW,
      cal: {
        createEvent: async () => { if (once) { once = false; throw new Error('rate limit'); } return { googleEventId: 'ok' }; },
        deleteEvent: async () => {},
      },
    });
    const mid = (await query(`SELECT * FROM calendar_events WHERE id=$1`, [softFail.calId])).rows[0];
    expect(mid.sync_status).toBe('pending');
    expect(mid.attempts).toBe(1);
  });
});

describe('hold sweeper', () => {
  it('expires stale holds and writes audit events; live holds untouched', async () => {
    const u = await query(
      `INSERT INTO users (role,email,password_hash,name) VALUES ('patient','hs@t.health','x','P') RETURNING id`,
    );
    const dU = await query(
      `INSERT INTO users (role,email,password_hash,name) VALUES ('doctor','hsdoc@t.health','x','D') RETURNING id`,
    );
    await query(
      `INSERT INTO doctors (user_id,specialisation,working_days,starts_at,ends_at,slot_minutes)
       VALUES ($1,'Gen','{1}','09:00'::time,'17:00'::time,30)`,
      [dU.rows[0].id],
    );
    const mkHold = async (stamp, expiresAt) => {
      const p = await query(
        `INSERT INTO users (role,email,password_hash,name) VALUES ('patient', $1,'x','P') RETURNING id`,
        [`hs${stamp.replace(/[^0-9]/g, '')}@t.health`],
      );
      const r = await query(
        `INSERT INTO appointments (patient_id, doctor_id, scheduled_at, status, hold_expires_at)
         VALUES ($1,$2,$3::timestamp,'held',$4) RETURNING id`,
        [p.rows[0].id, dU.rows[0].id, stamp, expiresAt],
      );
      return r.rows[0].id;
    };

    const stale = await mkHold('2026-08-24 10:00', plus(-10));
    const fresh = await mkHold('2026-08-24 11:00', plus(4));

    const r = await expireHolds({ query, now: () => NOW });
    expect(r.expired).toBe(1);

    const s = (await query(`SELECT * FROM appointments WHERE id=$1`, [stale])).rows[0];
    expect(s.status).toBe('expired');
    const ev = (await query(`SELECT * FROM appointment_events WHERE appointment_id=$1`, [stale])).rows[0];
    expect(ev.reason).toBe('hold_expired');
    expect(ev.actor_role).toBe('system');

    const f = (await query(`SELECT status FROM appointments WHERE id=$1`, [fresh])).rows[0];
    expect(f.status).toBe('held');
  });
});

describe('medication reminders', () => {
  it('enqueues only future doses inside the window, deduped across runs', async () => {
    const u = await query(
      `INSERT INTO users (role,email,password_hash,name) VALUES ('patient','mr2@t.health','x','P') RETURNING id`,
    );
    const dU = await query(
      `INSERT INTO users (role,email,password_hash,name) VALUES ('doctor','mrdoc2@t.health','x','D') RETURNING id`,
    );
    await query(
      `INSERT INTO doctors (user_id,specialisation,working_days,starts_at,ends_at,slot_minutes)
       VALUES ($1,'Gen','{1}','09:00'::time,'17:00'::time,30)`,
      [dU.rows[0].id],
    );
    const a = await query(
      `INSERT INTO appointments (patient_id, doctor_id, scheduled_at, status)
       VALUES ($1,$2,'2026-08-23 09:00','completed') RETURNING id`,
      [u.rows[0].id, dU.rows[0].id],
    );
    const apptId = a.rows[0].id;
    await query(
      `INSERT INTO visit_notes (appointment_id, clinical_notes, prescription)
       VALUES ($1,'n',$2::jsonb)`,
      [apptId, JSON.stringify([
        { name: 'Azithro', dosage: '250mg', times: ['09:30'], durationDays: 3 },
      ])],
    );

    // NOW = Aug 24 09:00 → today's 09:30 dose is inside the lookahead window.
    await scheduleMedicationReminders({ query, now: () => NOW });

    const rows = await query(
      `SELECT * FROM email_queue WHERE template='medication_reminder' ORDER BY id`,
    );
    expect(rows.rows.length).toBeGreaterThanOrEqual(1);
    for (const row of rows.rows) {
      expect(row.payload.time).toBe('09:30');
      expect(String(row.dedup_key)).toMatch(/^med:/);
    }

    await scheduleMedicationReminders({ query, now: () => NOW });
    const after = (
      await query(`SELECT count(*)::int AS n FROM email_queue WHERE template='medication_reminder'`)
    ).rows[0].n;
    expect(after).toBe(rows.rows.length);
  });
});

describe('POST /api/jobs/tick', () => {
  it('rejects wrong/missing secret with 403', async () => {
    expect((await request(app).post('/api/jobs/tick')).status).toBe(403);
    expect(
      (await request(app).post('/api/jobs/tick').set('x-job-secret', 'nope')).status,
    ).toBe(403);
  });

  it('runs every worker with the right secret and reports counts', async () => {
    const res = await request(app).post('/api/jobs/tick').set('x-job-secret', 'test-job-secret');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('emails');
    expect(res.body).toHaveProperty('calendar');
    expect(res.body).toHaveProperty('holdsExpired');
    expect(res.body).toHaveProperty('reminders');
    expect(res.body).toHaveProperty('summaries');
  });
});

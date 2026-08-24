import { describe, it, expect, afterAll } from 'vitest';
import {
  generatePreVisitContent,
  generatePostVisitContent,
} from '../src/services/llm/generate.js';
import { regeneratePendingSummaries } from '../src/services/llm/regenerate.js';
import { getTestPool, resetDb, closeTestPool } from './helpers.js';

const pool = await getTestPool();
const query = (t, v) => pool.query(t, v);

afterAll(closeTestPool);

const CFG_OPENAI = { provider: 'openai', apiKey: 'k', model: 'gpt-test', baseUrl: '' };
const okFetch = (body) => async () => ({
  ok: true,
  status: 200,
  json: async () => ({
    choices: [{ message: { content: typeof body === 'string' ? body : JSON.stringify(body) } }],
  }),
});

const VALID_PRE = {
  urgency: 'High',
  chiefComplaint: 'Chest pain',
  questions: ['q1', 'q2', 'q3'],
};

describe('LLM adapter fault-injection matrix', () => {
  it('success path parses strict JSON, normalizes urgency, records model', async () => {
    let called = 0;
    const fetchImpl = okFetch(VALID_PRE);
    const wrapped = async (...a) => { called += 1; return fetchImpl(...a); };
    const out = await generatePreVisitContent(
      { fetchImpl: wrapped, cfg: { llm: CFG_OPENAI } },
      'chest pain since morning',
    );
    expect(called).toBe(1);
    expect(out.source).toBe('llm');
    expect(out.model).toBe('gpt-test');
    expect(out.content).toEqual({
      urgency: 'high', chiefComplaint: 'Chest pain', questions: ['q1', 'q2', 'q3'],
    });
  });

  it('provider none → immediate fallback without network', async () => {
    let called = 0;
    const out = await generatePreVisitContent(
      { fetchImpl: async () => { called += 1; throw new Error('no'); }, cfg: { llm: { provider: 'none' } } },
      'mild cough',
    );
    expect(called).toBe(0);
    expect(out.source).toBe('fallback');
    expect(out.model).toBeNull();
    expect(out.content.urgency).toBe('low');
  });

  it.each([
    ['http error', async () => ({ ok: false, status: 500, json: async () => ({}) })],
    ['malformed json', async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'not json at all' } }] }) })],
    ['prose wrapper', async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'Sure! {"urgency":"High","chiefComplaint":"x","questions":["a","b","c"]}' } }] }) })],
    ['extra fields', async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"urgency":"High","chiefComplaint":"x","questions":["a","b","c"],"diagnosis":"stroke"}' } }] }) })],
    ['invalid enum', async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"urgency":"CRITICAL","chiefComplaint":"x","questions":["a","b","c"]}' } }] }) })],
    ['wrong arity', async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"urgency":"Low","chiefComplaint":"x","questions":["only","two"]}' } }] }) })],
    ['timeout', async (_url, init) => new Promise((_resolve, reject) => {
      const t = setTimeout(() => reject(new Error('should not resolve')), 1000);
      init.signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('AbortError')); });
    })],
  ])('%s → deterministic fallback', async (_name, fetchImpl) => {
    const out = await generatePreVisitContent(
      { fetchImpl, cfg: { llm: { ...CFG_OPENAI, timeoutMs: 20 } } },
      'symptoms',
    );
    expect(out.source).toBe('fallback');
    expect(out.model).toBeNull();
    expect(out.content.questions).toHaveLength(3);
  });
});

describe('post-visit adapter', () => {
  it('valid payload parses; bad shape falls back', async () => {
    const good = await generatePostVisitContent(
      { fetchImpl: okFetch({
        summaryMd: '# Get well',
        medicationSchedule: [{ name: 'P', dosage: '500mg', times: ['08:00'], durationDays: 3 }],
        followUp: 'Rest.',
      }), cfg: { llm: CFG_OPENAI } },
      'notes',
      [],
    );
    expect(good.source).toBe('llm');
    expect(good.content.medicationSchedule).toHaveLength(1);

    const bad = await generatePostVisitContent(
      { fetchImpl: okFetch({ summaryMd: 'missing other keys' }), cfg: { llm: CFG_OPENAI } },
      'notes',
      [],
    );
    expect(bad.source).toBe('fallback');
  });
});

describe('regeneratePendingSummaries lifecycle', () => {
  async function seedPending(kind) {
    await resetDb();
    // Direct inserts keep this test focused on the lifecycle, not the API:
    const u = await query(
      `INSERT INTO users (role,email,password_hash,name) VALUES ('patient','lp@t.health','x','LP') RETURNING id`,
    );
    const dU = await query(
      `INSERT INTO users (role,email,password_hash,name) VALUES ('doctor','ld@t.health','x','LD') RETURNING id`,
    );
    await query(
      `INSERT INTO doctors (user_id, specialisation, working_days, starts_at, ends_at, slot_minutes)
       VALUES ($1,'Gen','{1}','09:00'::time,'11:00'::time,20)`,
      [dU.rows[0].id],
    );
    const a = await query(
      `INSERT INTO appointments (patient_id, doctor_id, scheduled_at, status)
       VALUES ($1,$2,'2026-08-24 09:00'::timestamp,'confirmed') RETURNING id`,
      [u.rows[0].id, dU.rows[0].id],
    );
    const apptId = a.rows[0].id;
    if (kind === 'pre') {
      await query(
        `INSERT INTO pre_visit_summaries (appointment_id) VALUES ($1)`,
        [apptId],
      );
    } else {
      await query(`INSERT INTO visit_notes (appointment_id, clinical_notes) VALUES ($1,'n')`, [apptId]);
      await query(
        `INSERT INTO post_visit_summaries (appointment_id) VALUES ($1)`,
        [apptId],
      );
    }
    return apptId;
  }

  it('failing twice then succeeding → ready/llm with escalating backoff', async () => {
    const apptId = await seedPending('pre');
    let calls = 0;
    const gen = async () => {
      calls += 1;
      if (calls < 3) return { ok: false };
      return { ok: true, payload: { urgency: 'medium', chiefComplaint: 'cc', questions: ['1', '2', '3'] }, model: 'gpt-x' };
    };

    const base = Date.now() - 60_000;
    let now = new Date(base);
    const step = async () => {
      const r = await regeneratePendingSummaries({ query, now: () => now, generatePre: gen, generatePost: gen });
      now = new Date(now.getTime() + 30 * 60_000);
      return r;
    };

    expect((await step()).attempted).toBe(1);
    expect((await step()).attempted).toBe(1);

    let row = (await query(`SELECT * FROM pre_visit_summaries WHERE appointment_id=$1`, [apptId])).rows[0];
    expect(row.generation_status).toBe('pending');
    expect(row.attempts).toBe(2);

    expect((await step()).attempted).toBe(1);
    row = (await query(`SELECT * FROM pre_visit_summaries WHERE appointment_id=$1`, [apptId])).rows[0];
    expect(row.generation_status).toBe('ready');
    expect(row.source).toBe('llm');
    expect(row.model).toBe('gpt-x');
    expect(row.urgency).toBe('medium');

    // No longer claimed once ready.
    expect((await step()).attempted).toBe(0);
    expect(calls).toBe(3);
  });

  it('three strikes → permanent deterministic fallback, never retried again', async () => {
    const apptId = await seedPending('pre');
    const gen = async () => ({ ok: false });

    let now = new Date(Date.now());
    for (let i = 0; i < 3; i += 1) {
      const r = await regeneratePendingSummaries({
        query,
        now: () => now,
        generatePre: gen,
        generatePost: gen,
      });
      expect(r.attempted).toBe(1);
      now = new Date(now.getTime() + 130 * 60_000);
    }
    const row = (await query(`SELECT * FROM pre_visit_summaries WHERE appointment_id=$1`, [apptId])).rows[0];
    expect(row.generation_status).toBe('ready');
    expect(row.source).toBe('fallback');
    expect(row.chief_complaint).toBeTruthy();

    const again = await regeneratePendingSummaries({
      query,
      now: () => now,
      generatePre: gen,
      generatePost: gen,
    });
    expect(again.attempted).toBe(0);
  });

  it('post-visit rows fill through the same lifecycle', async () => {
    const apptId = await seedPending('post');
    const gen = async () => ({
      ok: true,
      payload: { summaryMd: 'md', medicationSchedule: [], followUp: 'rest' },
      model: 'm',
    });
    const r = await regeneratePendingSummaries({
      query,
      now: () => new Date(),
      generatePre: async () => ({ ok: false }),
      generatePost: gen,
    });
    expect(r.attempted).toBe(1);
    const row = (await query(`SELECT * FROM post_visit_summaries WHERE appointment_id=$1`, [apptId])).rows[0];
    expect(row.generation_status).toBe('ready');
    expect(row.summary_md).toContain('md');
    expect(row.follow_up).toBe('rest');
  });
});

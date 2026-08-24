import { preVisitPrompt, postVisitPrompt, fallbackPreVisit, fallbackPostVisit } from './prompts.js';

const URGENCIES = new Set(['low', 'medium', 'high']);
const DEFAULT_TIMEOUT_MS = 8000;

function exactKeys(obj, keys) {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return false;
  return Object.keys(obj).sort().join(',') === [...keys].sort().join(',');
}

function parseContent(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // prose, fences, truncation , anything non-JSON is a failure
  }
  return parsed;
}

function validPre(parsed) {
  if (!exactKeys(parsed, ['urgency', 'chiefComplaint', 'questions'])) return null;
  const urgency = String(parsed.urgency).toLowerCase();
  if (!URGENCIES.has(urgency)) return null;
  const { chiefComplaint, questions } = parsed;
  if (typeof chiefComplaint !== 'string' || !chiefComplaint.trim()) return null;
  if (
    !Array.isArray(questions) ||
    questions.length !== 3 ||
    questions.some((q) => typeof q !== 'string' || !q.trim())
  ) {
    return null;
  }
  return { urgency, chiefComplaint: chiefComplaint.trim(), questions: questions.map((q) => q.trim()) };
}

function validPost(parsed) {
  if (!exactKeys(parsed, ['summaryMd', 'medicationSchedule', 'followUp'])) return null;
  const { summaryMd, medicationSchedule, followUp } = parsed;
  if (typeof summaryMd !== 'string' || !summaryMd.trim()) return null;
  if (typeof followUp !== 'string') return null;
  if (!Array.isArray(medicationSchedule)) return null;
  for (const m of medicationSchedule) {
    if (!exactKeys(m, ['name', 'dosage', 'times', 'durationDays'])) return null;
    if (typeof m.name !== 'string' || !Array.isArray(m.times)) return null;
  }
  return { summaryMd, medicationSchedule: medicationSchedule, followUp };
}

async function callLlm(deps, prompt) {
  const cfg = deps.cfg?.llm ?? {};
  const timeoutMs = Number(cfg.timeoutMs) > 0 ? Number(cfg.timeoutMs) : DEFAULT_TIMEOUT_MS;

  let url;
  let headers;
  let body;
  if (cfg.provider === 'gemini') {
    const base = cfg.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
    url = `${base}/models/${cfg.model ?? 'gemini-2.0-flash'}:generateContent`;
    headers = { 'content-type': 'application/json', 'x-goog-api-key': cfg.apiKey };
    body = JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] });
  } else {
    const base = cfg.baseUrl ?? 'https://api.openai.com/v1';
    url = `${base}/chat/completions`;
    headers = { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` };
    body = JSON.stringify({
      model: cfg.model ?? 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await deps.fetchImpl(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, error: `http_${res.status}` };
    const raw = await res.json();
    const text =
      cfg.provider === 'gemini'
        ? raw?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('')
        : raw?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'empty_content' };
    return { ok: true, text };
  } catch (err) {
    const timedOut = err?.name === 'AbortError' || controller.signal.aborted;
    return { ok: false, error: timedOut ? 'timeout' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

const LOWER_URGENCY = { Low: 'low', Medium: 'medium', High: 'high' };

/**
 * Single-attempt generation. All transport/provider concerns collapse into one
 * boolean outcome here , retry/backoff policy lives in regenerate.js, and the
 * deterministic fallback lives in prompts.js. This function can never throw.
 */
export async function generatePreVisitContent(deps, symptoms) {
  if (deps.cfg?.llm?.provider === 'none' || !deps.cfg?.llm?.provider) {
    return { content: dbPre(fallbackPreVisit(symptoms)), source: 'fallback', model: null };
  }
  const res = await callLlm(deps, preVisitPrompt(symptoms));
  if (!res.ok) {
    return { content: dbPre(fallbackPreVisit(symptoms)), source: 'fallback', model: null };
  }
  const content = validPre(parseContent(res.text));
  if (!content) {
    return { content: dbPre(fallbackPreVisit(symptoms)), source: 'fallback', model: null };
  }
  return { content, source: 'llm', model: deps.cfg.llm.model ?? null };
}

function dbPre(content) {
  return { ...content, urgency: LOWER_URGENCY[content.urgency] ?? content.urgency };
}

/**
 * fallbackPostVisit renders plain markdown; the persistence contract (and the
 * success path above) speaks the structured {summaryMd, medicationSchedule,
 * followUp} shape. Bridge the two so fallback rows never land with NULL
 * summary columns.
 */
function dbPost(notes, prescription) {
  const meds = Array.isArray(prescription) ? prescription : [];
  return {
    summaryMd: fallbackPostVisit(notes, meds),
    medicationSchedule: meds.map((m) => ({
      name: m?.name ?? 'Medication',
      dosage: typeof m?.dosage === 'string' ? m.dosage : '',
      times: Array.isArray(m?.times) ? m.times : [],
      durationDays: Number.isFinite(Number(m?.durationDays)) ? Number(m.durationDays) : 0,
    })),
    followUp: 'If your symptoms get worse, contact the clinic.',
  };
}

export async function generatePostVisitContent(deps, notes, prescription) {
  if (deps.cfg?.llm?.provider === 'none' || !deps.cfg?.llm?.provider) {
    return { content: dbPost(notes, prescription), source: 'fallback', model: null };
  }
  const res = await callLlm(deps, postVisitPrompt(notes, prescription));
  if (!res.ok) {
    return { content: dbPost(notes, prescription), source: 'fallback', model: null };
  }
  const content = validPost(parseContent(res.text));
  if (!content) {
    return { content: dbPost(notes, prescription), source: 'fallback', model: null };
  }
  return { content, source: 'llm', model: deps.cfg.llm.model ?? null };
}

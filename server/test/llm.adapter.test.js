import { describe, it, expect, vi } from 'vitest';
import { generatePreVisitContent, generatePostVisitContent } from '../src/services/llm/generate.js';

const SYMPTOMS = 'Persistent dry cough for five days, worse at night.';
const NOTES = 'Viral upper respiratory infection. Rest and hydration advised.';
const RX = [{ name: 'Paracetamol', dosage: '500mg', times: ['08:00', '20:00'], durationDays: 3 }];

const VALID_PRE = {
  urgency: 'High',
  chiefComplaint: 'Dry cough worsening at night',
  questions: ['How long?', 'Any fever?', 'Any exposure?'],
};

function okRes(body) {
  return {
    ok: true,
    json: async () => body,
  };
}

function openaiBody(content) {
  return { choices: [{ message: { content } }] };
}

function geminiBody(text) {
  return { candidates: [{ content: { parts: [{ text }] } }] };
}

function deps(overrides = {}, fetchImpl) {
  return {
    cfg: {
      llm: {
        provider: 'openai',
        apiKey: 'test-key',
        ...overrides,
      },
    },
    fetchImpl:
      fetchImpl ??
      vi.fn(async () => okRes(openaiBody(JSON.stringify(VALID_PRE)))),
  };
}

describe('callLlm request shapes (via generatePreVisitContent)', () => {
  it('openai: posts to {base}/chat/completions with Bearer key, model default, temperature 0', async () => {
    const fetchImpl = vi.fn(async () => okRes(openaiBody(JSON.stringify(VALID_PRE))));
    await generatePreVisitContent(deps({}, fetchImpl), SYMPTOMS);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(init.headers.authorization).toBe('Bearer test-key');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('gpt-4o-mini'); // default when LLM_MODEL unset
    expect(body.temperature).toBe(0);
    expect(body.messages).toEqual([{ role: 'user', content: expect.stringContaining('cough') }]);
  });

  it('openai: honours custom baseUrl and model from config', async () => {
    const fetchImpl = vi.fn(async () => okRes(openaiBody(JSON.stringify(VALID_PRE))));
    await generatePreVisitContent(deps({ baseUrl: 'http://localhost:9/v1', model: 'gpt-x' }, fetchImpl), SYMPTOMS);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://localhost:9/v1/chat/completions');
    expect(JSON.parse(init.body).model).toBe('gpt-x');
  });

  it('gemini: posts to models/{model}:generateContent with x-goog-api-key header', async () => {
    const fetchImpl = vi.fn(async () =>
      okRes(geminiBody(JSON.stringify(VALID_PRE))),
    );
    const d = deps({ provider: 'gemini', model: 'gemini-2.0-flash' }, fetchImpl);
    const out = await generatePreVisitContent(d, SYMPTOMS);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
    );
    expect(init.headers['x-goog-api-key']).toBe('test-key');
    expect(JSON.parse(init.body).contents[0].parts[0].text).toContain('cough');

    // Gemini parts are joined before parsing.
    expect(out.source).toBe('llm');
    expect(out.content.urgency).toBe('high');
  });
});

describe('transport faults collapse into deterministic fallback', () => {
  const cases = {
    'http 500': async () => ({ ok: false, status: 500 }),
    'http 429': async () => ({ ok: false, status: 429 }),
    'malformed json': async () => ({ ok: true, json: async () => { throw new SyntaxError('Unexpected token'); } }),
    'empty choices': async () => okRes({ choices: [] }),
    'missing message': async () => okRes({ choices: [{}] }),
    'empty content string': async () => okRes(openaiBody('   ')),
    'network rejection': async () => { throw new Error('ECONNREFUSED'); },
  };

  for (const [name, impl] of Object.entries(cases)) {
    it(`pre-visit ${name} → fallback content, source=fallback, model=null`, async () => {
      const out = await generatePreVisitContent(deps({}, impl), SYMPTOMS);
      expect(out.source).toBe('fallback');
      expect(out.model).toBeNull();
      expect(out.content.urgency).toBeTypeOf('string');
      expect(out.content.questions).toHaveLength(3);
      // Fallback rubric still reflects the symptom text.
      expect(out.content.chiefComplaint.length).toBeGreaterThan(0);
    });
  }

  it('post-visit transport failure → fallback summary mentioning schedule sections', async () => {
    const out = await generatePostVisitContent(deps({}, async () => ({ ok: false, status: 503 })), NOTES, RX);
    expect(out.source).toBe('fallback');
    expect(out.content.summaryMd).toContain('What the doctor found');
    expect(out.content.medicationSchedule).toHaveLength(1);
    expect(typeof out.content.followUp).toBe('string');
  });

  it('timeout aborts the request quickly and still falls back (never throws)', async () => {
    const hanging = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const err = new Error('This operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    const started = Date.now();
    const out = await generatePreVisitContent(deps({ timeoutMs: 20 }, hanging), SYMPTOMS);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(out.source).toBe('fallback');
  });

  it('provider "none" never touches the network', async () => {
    const fetchImpl = vi.fn();
    const out = await generatePreVisitContent(deps({ provider: 'none' }, fetchImpl), SYMPTOMS);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(out.source).toBe('fallback');
  });
});

describe('strict pre-visit payload validation', () => {
  const bad = {
    'urgency not in enum': { ...VALID_PRE, urgency: 'EXTREME' },
    'two questions': { ...VALID_PRE, questions: ['a', 'b'] },
    'four questions': { ...VALID_PRE, questions: ['a', 'b', 'c', 'd'] },
    'non-string question': { ...VALID_PRE, questions: ['a', 4, 'c'] },
    'blank question': { ...VALID_PRE, questions: ['a', '  ', 'c'] },
    'empty chief complaint': { ...VALID_PRE, chiefComplaint: '' },
    'missing chiefComplaint': { urgency: 'high', questions: ['1', '2', '3'] },
    'missing questions': { urgency: 'high', chiefComplaint: 'x' },
    'extra key': { ...VALID_PRE, diagnosis: 'cancer' },
    'array instead of object': ['nope'],
    'prose instead of JSON': 'The patient seems fine, here is my advice...',
    'json-fenced prose': '```json\n{"urgency":"high"}\n```',
  };

  for (const [name, payload] of Object.entries(bad)) {
    it(`rejects ${name} → fallback`, async () => {
      const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
      const out = await generatePreVisitContent(deps({}, async () => okRes(openaiBody(raw))), SYMPTOMS);
      expect(out.source).toBe('fallback');
    });
  }

  it('accepts valid payload; lowercases urgency, trims strings, echoes model', async () => {
    const payload = {
      urgency: 'Medium', // case-insensitive (whitespace would be rejected)
      chiefComplaint: '  Chest pain on exertion  ',
      questions: [' Q1 ', 'Q2', 'Q3'],
    };
    const out = await generatePreVisitContent(
      deps({ model: 'gpt-test-model' }, async () => okRes(openaiBody(JSON.stringify(payload)))),
      SYMPTOMS,
    );
    expect(out.source).toBe('llm');
    expect(out.model).toBe('gpt-test-model');
    expect(out.content.urgency).toBe('medium');
    expect(out.content.chiefComplaint).toBe('Chest pain on exertion');
    expect(out.content.questions).toEqual(['Q1', 'Q2', 'Q3']);
  });
});

describe('strict post-visit payload validation', () => {
  const VALID_POST = {
    summaryMd: '# Summary',
    medicationSchedule: [{ name: 'Paracetamol', dosage: '500mg', times: ['08:00'], durationDays: 3 }],
    followUp: 'Return if fever persists.',
  };

  const bad = {
    'medication extra key': {
      ...VALID_POST,
      medicationSchedule: [
        { name: 'X', dosage: '', times: ['08:00'], durationDays: 2, strength: '500mg' },
      ],
    },
    'times not array': {
      ...VALID_POST,
      medicationSchedule: [{ name: 'X', dosage: '', times: '08:00', durationDays: 2 }],
    },
    'followUp number': { ...VALID_POST, followUp: 42 },
    'empty summaryMd': { ...VALID_POST, summaryMd: '' },
    'missing medicationSchedule': {
      summaryMd: 's',
      followUp: 'f',
    },
    'prose response': 'Here is your friendly summary!',
  };

  for (const [name, payload] of Object.entries(bad)) {
    it(`rejects ${name} → fallback`, async () => {
      const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
      const out = await generatePostVisitContent(deps({}, async () => okRes(openaiBody(raw))), NOTES, RX);
      expect(out.source).toBe('fallback');
    });
  }

  it('accepts valid payload with source=llm', async () => {
    const out = await generatePostVisitContent(
      deps({}, async () => okRes(openaiBody(JSON.stringify(VALID_POST)))),
      NOTES,
      RX,
    );
    expect(out.source).toBe('llm');
    expect(out.content.medicationSchedule[0].name).toBe('Paracetamol');
  });
});

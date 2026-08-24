import { describe, it, expect } from 'vitest';
import {
  preVisitPrompt,
  postVisitPrompt,
  fallbackPreVisit,
  fallbackPostVisit,
} from '../src/services/llm/prompts.js';

describe('prompt templates (brief-verbatim)', () => {
  it('pre-visit prompt contains the brief instruction word-for-word', () => {
    const p = preVisitPrompt('Cough for five days');
    expect(p).toContain(
      'Analyse these symptoms and return: urgency level (Low / Medium / High), chief complaint, and three suggested questions for the doctor.',
    );
    expect(p).toContain('Symptoms: Cough for five days');
    expect(p.toLowerCase()).toContain('json');
  });

  it('post-visit prompt contains the brief instruction word-for-word', () => {
    const p = postVisitPrompt(
      'Viral URI. Symptomatic care.',
      [{ name: 'Paracetamol', dosage: '500mg', times: ['08:00', '20:00'], durationDays: 3 }],
    );
    expect(p).toContain(
      'Convert these clinical notes into a patient-friendly summary with medication schedule and follow-up steps:',
    );
    expect(p).toContain('Paracetamol');
    expect(p).toContain('08:00');
    expect(p.toLowerCase()).toContain('json');
  });
});

describe('fallbackPreVisit (deterministic rubric)', () => {
  it('red-flag keywords → High urgency', () => {
    const out = fallbackPreVisit('Crushing chest pain since morning');
    expect(out.urgency).toBe('High');
    expect(out.questions).toHaveLength(3);
  });

  it('fever/severe/worsening signals → Medium', () => {
    expect(fallbackPreVisit('Fever for four days, getting worse').urgency).toBe('Medium');
    expect(fallbackPreVisit('Severe throat pain').urgency).toBe('Medium');
  });

  it('ordinary complaints → Low', () => {
    const out = fallbackPreVisit('Mild dry cough at night');
    expect(out.urgency).toBe('Low');
    expect(out.chiefComplaint.length).toBeGreaterThan(0);
    expect(out.chiefComplaint.length).toBeLessThanOrEqual(80);
  });

  it('empty or hostile input never throws and yields Low + generic questions', () => {
    for (const input of ['', '   ', null, undefined, { evil: true }, '<script>x</script>']) {
      const out = fallbackPreVisit(input);
      expect(out.urgency).toBe('Low');
      expect(out.chiefComplaint).toBeTruthy();
      expect(out.questions).toHaveLength(3);
    }
  });

  it('chief complaint trims to first sentence, max 80 chars', () => {
    const long = `${'A very long complaint sentence. '.repeat(4)}Second sentence here.`;
    const out = fallbackPreVisit(long);
    expect(out.chiefComplaint.length).toBeLessThanOrEqual(80);
    expect(out.chiefComplaint).not.toContain('Second sentence');
  });
});

describe('fallbackPostVisit (templated markdown)', () => {
  it('renders findings, medication schedule lines, follow-up', () => {
    const md = fallbackPostVisit(
      'Mild viral infection. Throat inflamed.',
      [
        { name: 'Paracetamol', dosage: '500mg', times: ['08:00', '20:00'], durationDays: 3 },
        { name: 'Cetirizine', dosage: '10mg', times: ['22:00'], durationDays: 5 },
      ],
    );
    expect(md).toContain('viral infection');
    expect(md).toContain('Paracetamol');
    expect(md).toContain('500mg');
    expect(md).toMatch(/08:00.*20:00|20:00.*08:00/);
    expect(md).toContain('3 days');
    expect(md.toLowerCase()).toContain('follow');
  });

  it('handles empty prescription gracefully', () => {
    const md = fallbackPostVisit('Healthy.', []);
    expect(typeof md).toBe('string');
    expect(md.length).toBeGreaterThan(0);
  });
});

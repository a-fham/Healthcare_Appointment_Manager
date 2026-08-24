const PRE_VISIT_INSTRUCTION =
  'Analyse these symptoms and return: urgency level (Low / Medium / High), chief complaint, and three suggested questions for the doctor.';

const POST_VISIT_INSTRUCTION =
  'Convert these clinical notes into a patient-friendly summary with medication schedule and follow-up steps:';

const PRE_VISIT_SHAPE =
  '{"urgency": "Low" | "Medium" | "High", "chiefComplaint": "<one line>", "questions": ["...", "...", "..."]}';

const POST_VISIT_SHAPE =
  '{"summaryMd": "<patient-friendly markdown>", "medicationSchedule": [{"name": "...", "dosage": "...", "times": ["08:00"], "durationDays": 3}], "followUp": "<one or two sentences>"}';

export function preVisitPrompt(symptoms) {
  return [
    'You are a triage support assistant for a clinic front desk. You never diagnose.',
    '',
    PRE_VISIT_INSTRUCTION,
    '',
    `Respond with ONLY valid JSON of exactly this shape. No markdown fences, no extra keys, no commentary:`,
    PRE_VISIT_SHAPE,
    '',
    `Symptoms: ${String(symptoms)}`,
  ].join('\n');
}

function formatPrescription(prescription) {
  const list = Array.isArray(prescription) ? prescription : [];
  if (list.length === 0) return '(none)';
  return list
    .map(
      (m) =>
        `- ${m.name ?? '?'} ${m.dosage ?? ''} at ${(Array.isArray(m.times) ? m.times : []).join(' & ') || 'as directed'} for ${m.durationDays ?? '?'} days`,
    )
    .join('\n');
}

export function postVisitPrompt(notes, prescription) {
  return [
    'You are a clinic assistant helping doctors write plain-language summaries for patients.',
    '',
    POST_VISIT_INSTRUCTION,
    '',
    `Respond with ONLY valid JSON of exactly this shape. No markdown fences, no extra keys, no commentary:`,
    POST_VISIT_SHAPE,
    '',
    `Clinical notes: ${String(notes)}`,
    'Prescription:',
    formatPrescription(prescription),
  ].join('\n');
}

const HIGH_FLAGS = [
  'chest pain',
  'trouble breathing',
  'difficulty breathing',
  'shortness of breath',
  'uncontrolled bleeding',
  'heavy bleeding',
  'unconscious',
  'fainted',
  'seizure',
  'slurred speech',
];

const MEDIUM_FLAGS = [
  'fever',
  'severe',
  'worsening',
  'getting worse',
  'worse',
  'vomiting',
  'dehydrated',
  'dizzy',
];

const QUESTION_BANKS = {
  High: [
    'When exactly did the symptoms start, and have they intensified in the last few hours?',
    'Is there any pain spreading to the chest, arm, jaw, or back right now?',
    'Has there been fainting, severe breathlessness, or uncontrolled bleeding at any point?',
  ],
  Medium: [
    'Have you been able to eat, drink, and sleep normally despite the symptoms?',
    'What is your temperature trend over the past few days? Has it spiked?',
    'Are you currently taking any other medication for this?',
  ],
  Low: [
    'How would you describe the discomfort on a scale from 1 to 10 today?',
    'Does anything make it clearly better or clearly worse?',
    'Have you had this same problem before, and how was it handled then?',
  ],
};

function asText(value) {
  return typeof value === 'string' ? value : '';
}

export function fallbackPreVisit(symptoms) {
  const text = asText(symptoms).toLowerCase();

  let urgency = 'Low';
  if (HIGH_FLAGS.some((f) => text.includes(f))) urgency = 'High';
  else if (MEDIUM_FLAGS.some((f) => text.includes(f))) urgency = 'Medium';

  let complaint = asText(symptoms).trim().split(/[.!?\n]/)[0].trim();
  if (complaint.length > 80) complaint = `${complaint.slice(0, 77).trim()}...`;
  if (!complaint) complaint = 'General consultation.';

  return {
    urgency,
    chiefComplaint: complaint,
    questions: [...QUESTION_BANKS[urgency]],
  };
}

function timesLabel(times) {
  return (Array.isArray(times) ? times : []).join(' & ') || 'as directed';
}

export function fallbackPostVisit(notes, prescription) {
  const findings = asText(notes).trim() || 'As discussed with your doctor.';
  const meds = Array.isArray(prescription) ? prescription : [];

  const lines = [];
  lines.push('## What the doctor found');
  lines.push(findings);
  lines.push('');
  lines.push('## Medication schedule');

  if (meds.length === 0) {
    lines.push('No medications were prescribed.');
  } else {
    for (const m of meds) {
      const name = m?.name ?? 'Medication';
      const dosage = m?.dosage ? ` ${m.dosage}` : '';
      const days = Number(m?.durationDays);
      const duration = Number.isFinite(days) && days > 0 ? ` for ${days} day${days === 1 ? '' : 's'}` : '';
      lines.push(`- ${name}${dosage}, take at ${timesLabel(m?.times)}${duration}`);
    }
  }

  lines.push('');
  lines.push('## Follow-up');
  lines.push(
    'If your symptoms get worse, or do not start improving within a few days, contact the clinic or book another appointment.',
  );

  return lines.join('\n');
}

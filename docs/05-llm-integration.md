# 05 , LLM Integration

Summaries are generated asynchronously by a background worker , **booking never
waits on the LLM** (R12). Confirm creates a `pending` summary row; each tick
claims due rows with `FOR UPDATE SKIP LOCKED`, calls the provider, retries on
failure with backoff (1 → 5 → 25 min), and after 3 strikes writes the
deterministic fallback permanently with `source='fallback'`. The doctor's queue
shows *“summary preparing…”* meanwhile.

Provider is config-driven (`LLM_PROVIDER=none|openai|gemini`), called over
native `fetch`; `none` skips the network entirely and uses the fallback
rubric , the full flow works keyless.

## Prompts

Source: [`server/src/services/llm/prompts.js`](../server/src/services/llm/prompts.js).
The brief's wording is the core instruction, verbatim, and a snapshot test pins
it. The model must answer with exactly one JSON object:

**Pre-visit** (`preVisitPrompt(symptoms)`):

```
You are a triage support assistant for a clinic front desk. You never diagnose.

Analyse these symptoms and return: urgency level (Low / Medium / High), chief complaint, and three suggested questions for the doctor.

Respond with ONLY valid JSON of exactly this shape , no markdown fences, no extra keys, no commentary:
{"urgency": "Low" | "Medium" | "High", "chiefComplaint": "<one line>", "questions": ["...", "...", "..."]}

Symptoms: <patient's symptom form text>
```

**Post-visit** (`postVisitPrompt(notes, prescription)`):

```
You are a clinic assistant helping doctors write plain-language summaries for patients.

Convert these clinical notes into a patient-friendly summary with medication schedule and follow-up steps:

Respond with ONLY valid JSON of exactly this shape , no markdown fences, no extra keys, no commentary:
{"summaryMd": "<patient-friendly markdown>", "medicationSchedule": [{"name": "...", "dosage": "...", "times": ["08:00"], "durationDays": 3}], "followUp": "<one or two sentences>"}

Clinical notes: <doctor's notes>
Prescription:
- Paracetamol 500mg at 08:00 & 20:00 for 3 days
```

## Output gate (prompt-injection / malformed-output defence)

The adapter accepts only a strict JSON parse whose top-level keys are *exactly*
the requested set with correctly-typed values (3 questions; medication entries
with name/dosage/times[]/durationDays). Any deviation , prose wrapper, extra
keys, missing fields, non-JSON, HTTP error, or an 8 s timeout , counts as a
failed attempt and falls back. AI output is stored, never executed; the UI
renders summaries as plain text only.

## Deterministic fallback rubric

Keyword tiers over lower-cased symptom text:

- **High**: chest pain · trouble/difficulty breathing · shortness of breath ·
  uncontrolled/heavy bleeding · unconscious · fainted · seizure · slurred speech
- **Medium**: fever · severe · worsening/getting worse/worse · vomiting ·
  dehydrated · dizzy
- else **Low**

Chief complaint = first sentence of the symptom text (≤80 chars); three
suggested questions come from a per-tier question bank. Post-visit fallback
renders a fixed template: what the doctor found (notes echoed in plain text),
the medication schedule as bullet lines derived from the structured
prescription, and generic follow-up advice.

Both fallbacks are honest about provenance (`source='fallback'`, `model=null`)
, decision support that never pretends to be more than it is.

---
status: superseded by ADR-0011 (scope discipline , see ROADMAP.md)
---

# Dependents: account-holder vs visit-subject split

We decided that a booking is always owned by the account holder (the registered
patient), but may be *for* a **dependent** â€” a family member (name, age,
relation) the patient registers. Clinical artifacts (symptom form context,
pre-visit summary, doctor queue entry, post-visit summary) attach to the visit
subject; every notification attaches to the account holder. Dependents have no
credentials and never log in.

## Why

- Family-mediated healthcare â€” one adult booking for spouse, children, parents â€”
  is the dominant real-world pattern for this product's population, and it is
  absent from the base glossary, which makes it a genuine differentiator.
- The split mirrors how clinics actually register: a patient file per person,
  one guardian/contact of record. It also avoids pseudo-accounts for dependents
  â€” no second credential set to secure or leak.

## Considered options

- **Separate login per family member** â€” rejected: unrealistic for elderly
  dependents, doubles auth surface for zero product value.
- **Free-text "booking notes" field instead of an entity** â€” rejected:
  unqueryable, no integrity on relation/age, summaries can't reliably address
  the visit subject.

## Consequences

- `appointments.dependent_id` nullable FK + `dependents` table with
  `UNIQUE(patient_id, name)`; ownership checks extend to dependent rows (IDOR
  posture unchanged).
- Doctor queue and summaries render "For: <name> Â· <age> Â· <relation>" when set.

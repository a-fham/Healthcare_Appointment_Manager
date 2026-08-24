# 02 , Database Schema

PostgreSQL 16, raw SQL migrations applied in order by `server/src/db/migrate.js`
at boot and via `npm run migrate`. Source of truth:
[`server/migrations/0001_init.sql`](../server/migrations/0001_init.sql) +
[`0002_calendar_retries.sql`](../server/migrations/0002_calendar_retries.sql) +
[`0003_booking_overlap_constraints.sql`](../server/migrations/0003_booking_overlap_constraints.sql).
Datetimes for appointments are clinic-local naive `TIMESTAMP`s (single clinic);
all bookkeeping columns are `TIMESTAMPTZ`.

## Tables

**users** , `id`, `role` (`patient|doctor|admin`), `email` UNIQUE,
`password_hash`, `name`, `phone`. Doctors never self-register; an admin seeds
them.

**doctors** , 1:1 extension of users (`user_id` PK → users). Holds
`specialisation`, `working_days INT[]` (0=Sun…6=Sat), `starts_at`/`ends_at`
TIME, `slot_minutes`. Working hours tile into slots by `slots.service.js`.

**leave_days** , `(doctor_id, date)` PK. A row suppresses that doctor's slots
for the date.

**appointments** , the central table. `status ∈ held | confirmed | completed |
cancelled_by_patient | cancelled_by_admin | cancelled_by_leave | expired |
rescheduled`; symptom fields (`symptoms_text`, `severity ∈ mild|moderate|severe`,
`duration_text`) are written at confirm; `hold_expires_at` bounds a hold.

### The graded walls (partial unique indexes + EXCLUDE)

```sql
CREATE UNIQUE INDEX uniq_appt_doctor_slot ON appointments (doctor_id, scheduled_at)
  WHERE status IN ('held', 'confirmed');   -- no double-booking, ever

CREATE UNIQUE INDEX uniq_appt_patient_hold ON appointments (patient_id)
  WHERE status = 'held';                   -- one active hold per patient

CREATE UNIQUE INDEX uniq_appt_patient_doctor_day
  ON appointments (patient_id, doctor_id, (scheduled_at::date))
  WHERE status IN ('held', 'confirmed');   -- one live booking per (patient, doctor, day)

ALTER TABLE appointments ADD CONSTRAINT no_patient_time_overlap
  EXCLUDE USING gist (
    patient_id WITH =,
    tstzrange(scheduled_at::timestamptz, overlap_until, '[)') WITH &&
  )
  WHERE (status IN ('held', 'confirmed')); -- no patient has overlapping live slots
```

`overlap_until` is a STORED generated column that adds the doctor's
`slot_minutes` to `scheduled_at` so two appointments overlap if either
contains the other's start. The EXCLUDE then rejects the second insert
transactionally.

The database itself makes the forbidden states unwritable , application code
maps SQLSTATE `23505` / `23P01` to `SLOT_TAKEN` / `HOLD_EXISTS` /
`SAME_DOCTOR_SAME_DAY` / `TIME_OVERLAP` errors. Verified under
parallel load by `server/scripts/concurrency-proof.mjs`.

**pre_visit_summaries** , 1:1 with appointments. AI output (`urgency ∈
low|medium|high`, `chief_complaint`, `questions JSONB`) plus lifecycle:
`generation_status pending|ready`, `source llm|fallback`, `model`, `attempts`,
`next_attempt_at` (backoff ladder).

**visit_notes** , doctor's post-visit record: `clinical_notes`,
`prescription JSONB [{name,dosage,times[],durationDays}]`.

**post_visit_summaries** , plain-language patient version: `summary_md`,
`medication_schedule JSONB`, `follow_up`; same lifecycle columns as pre-visit.

**email_queue** (notification outbox) , every outbound message is a row:
`template`, `payload JSONB`, `status pending|sent|failed`, `attempts`,
`next_attempt_at`, `sent_at`, `last_error`, logical `dedup_key`. Partial unique
index on `dedup_key WHERE status <> 'failed'` gives at-most-once per logical
event while retryable; dead-lettering frees the key.

**calendar_events** , one row per `(appointment_id, audience∈patient|doctor)`:
`google_event_id`, `sync_status pending|synced|failed|skipped|deleting|deleted`,
`attempts`, `next_attempt_at` (0002), `last_error`.

**notification_log** , delivery audit: channel/kind/status/detail.

**appointment_events** , audit of every appointment transition
(`from_status`,`to_status`,`actor_role ∈ system|patient|doctor|admin`,
`reason`), always inserted in the same transaction as the transition.
Leave-cascade rows carry reason `leave:<date>`; expired holds carry
`hold_expired`.

**job_state** , scheduler heartbeat (`name='tick'`, `last_run_at`) surfaced in
the admin health view.

## Invariants enforced below the application

- A doctor cannot have two live rows (`held|confirmed`) at one moment.
- A patient cannot hold two slots at once.
- A prescription drives reminders only while
  `visit_date ≤ reminder_time < visit_date + durationDays`.
- Cancelling anything leaves a full event trace behind.

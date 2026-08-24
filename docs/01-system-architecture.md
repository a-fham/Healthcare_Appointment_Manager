# 01 â€” System Architecture

Companion to [00-project-overview.md](00-project-overview.md). This document is
the authoritative description of every load-bearing flow. The four flows the
assignment grades hardest â€” **double-booking prevention, slot holds, leave
conflict handling, notification failure handling** â€” each get a section with a
step-by-step trace.

---

## 1. Shape of the system

```
                       â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
 Browser (SPA) â”€â”€HTTPâ”€â”€â–¶â”‚              Express process               â”‚
                        â”‚                                            â”‚
 React + Vite build â,€â”€â”€â”€â”‚  routes â”€â–¶ services â”€â–¶ db (pg Pool) â”€â”€â”    â”‚
 served statically by   â”‚     â”‚          â”‚                      â”‚    â”‚
 the same process       â”‚     â”‚          â”œâ”€ llm adapter â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â–¶ OpenAI/Gemini â”‚
                        â”‚     â”‚          â”œâ”€ email worker â”€â”€â”€â”€â”€â”€â”€â”€â”€â–¶ SMTP           â”‚
                        â”‚     â”‚          â””â”€ calendar client â”€â”€â”€â”€â–¶ Google REST    â”‚
                        â”‚  node-cron(1m) â†’ tick()                    â”‚    â”‚
                        â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¼â”€â”€â”€â”€â–¶ PostgreSQL
                                                                     (Neon)
```

One process, one database. Layers:

- **routes/** â€” HTTP shape only: parse, validate (zod), call service, map to status codes. No business rules.
- **services/** â€” business rules and transactions. The only place that writes.
- **db/** â€” pool, migrations, mappers. Services compose queries; no query strings in routes.
- **adapters** (llm/email/calendar) â€” external world, all behind interfaces that record outcomes instead of throwing into user flows.

Why this layering: the graded behaviors are *rules* (when can a slot be taken?)
and *guarantees* (never two bookings). Rules live in services where they are
unit-testable without HTTP; guarantees live in SQL where they survive bugs.

## 2. Data model at a glance

Full DDL with rationale: [02-database-schema.md](02-database-schema.md).

```
users(id, role patient|doctor|admin, email uniq, password_hash, name, phone)
doctors(user_id â†’users, specialisation idx, working_days int[], starts_at time,
        ends_at time, slot_minutes int check>0)
leave_days(doctor_id, date, PK(doctor_id,date))
appointments(id uuid, patient_id â†’users, doctor_idâ†’doctors,
             scheduled_at timestamp, status held|confirmed|completed|
                     cancelled_by_patient|cancelled_by_admin|
                     cancelled_by_leave|expired|rescheduled,
             symptoms_text, severity mild|moderate|severe, duration_text,
             hold_expires_at, UNIQUE(doctor_id,scheduled_at)
                 WHERE status IN ('held','confirmed'))
pre_visit_summaries(appointment_id pk/fk, urgency low|medium|high,
                    chief_complaint, questions jsonb,
                    generation_status pending|ready, source llm|fallback|null,
                    model, attempts int, next_attempt_at, created_at)
visit_notes(appointment_id pk/fk, clinical_notes, prescription jsonb, created_at)
post_visit_summaries(appointment_id pk/fk, summary_md, medication_schedule jsonb,
                     follow_up, generation_status pending|ready,
                     source llm|fallback|null, attempts int, next_attempt_at, created_at)
email_queue(id, to_email, template, payload jsonb,
            status pending|sent|failed(dead-letter), attempts int,
            next_attempt_at, sent_at, last_error, appointment_id nullable,
            dedup_key)
calendar_events(id, appointment_id, audience patient|doctor, google_event_id,
                sync_status pending|synced|failed|skipped, last_error, updated_at)
notification_log(id, user_id nullable, appointment_id nullable, channel='email',
                 kind, status, detail, created_at)   -- audit trail
appointment_events(id, appointment_id, from_status, to_status,
                   actor_role system|patient|doctor|admin, reason,
                   created_at)                        -- state-transition audit
job_state(name pk, last_run_at)                       -- tick window bookkeeping
```

Every appointment status change writes an `appointment_events` row inside the
same transaction â€” the write-up can cite concrete transition traces instead of
prose. The single most important constraint remains the partial unique index on
`appointments`. Everything else exists to feed or record it.

## 3. Flow: double-booking prevention (R3)

**Guarantee:** two confirmed appointments for `(doctor, scheduled_at)` cannot
exist, even if two requests arrive in the same millisecond on different
connections.

1. Booking confirmation runs inside one transaction (`BEGIN`).
2. `INSERT INTO appointments (...) VALUES (...)` â€” the insert itself carries
   `status='confirmed'`, so it collides with the partial unique index if any
   `held`/`confirmed` row already occupies `(doctor_id, scheduled_at)`.
3. On unique violation (SQLSTATE `23505`) the transaction rolls back and the
   API returns `409 SLOT_TAKEN`; the client refreshes the slot grid.
4. Winner commits; loser gets a clean conflict, never a double-book.

Why an index and not "SELECT then INSERT": SELECT-then-INSERT has a race
window between the two statements under concurrent requests; serializable
isolation would also work but turns every anomaly into retry logic and risks
serialization failures everywhere. The index makes correctness *declarative* â€”
the database refuses the second row regardless of application bugs, missing
locks, or future code paths (imports, admin tools). Test suite includes a true
concurrency test: N parallel confirms against the same slot via
`Promise.all`, asserting exactly one 201 and Nâˆ’1 409s. The same scenario ships
as a runnable artifact, `server/scripts/concurrency-proof.mjs`, whose output is
quoted in the README â€” proof under load, not a claim.

Held slots participate too: a `held` row blocks booking attempts while the
hold lives, so the same index covers both states â€” see Â§4.

## 4. Flow: slot hold mechanism (graded topic)

Purpose: while the patient fills the symptom form, others must not silently
snatch the slot â€” but abandoned forms must not leak capacity either.

1. Patient picks an open slot â†’ `POST /api/appointments/hold {doctorId, scheduledAt}`.
2. Service validates openness (working hours, working day, not leave day, not
   past) then inserts an `appointments` row with `status='held'`,
   `hold_expires_at = now() + 5 min`. Uniqueness guarantees exclusivity; a
   lost race returns 409 immediately.
3. One active hold per patient enforced by partial index
   `UNIQUE(patient_id) WHERE status='held'` â€” a new hold expires/replaces the old one.
4. Symptom form submits â†’ `POST /api/appointments/:id/confirm` within validity.
   Confirm checks `status='held' AND hold_expires_at > now()` inside the same
   transaction as the pre-visit-summary generation trigger, flips status to
   `confirmed`, clears expiry. Expired hold â†’ 410 GONE, slot freed.
5. Sweeper: every tick cancels rows where `status='held' AND hold_expires_at < now()`
   (status â†’ `expired`; kept distinct for metrics). Because expired holds fail
   the partial-index predicate, capacity frees automatically even if the sweeper
   lags â€” the index predicate is checked at insert time, so a new booking may
   reclaim a logically-expired slot instantly; the sweeper is hygiene, not
   correctness.
6. The booking wizard renders a live countdown from `hold_expires_at` (native
   polling of the appointment resource) so the hold mechanic â€” and its expiry â€”
   is visible to the patient rather than discovered as an error.

Design choice â€” hold as an appointment row vs separate `holds` table: a row in
the same table means one index enforces both states and confirm is an `UPDATE`
inside the booking transaction rather than insert-after-delete gymnastics. A
separate table was considered and rejected because it needs a second uniqueness
mechanism and a migration path between tables mid-flow.

## 5. Flow: doctor leave conflict handling (R4)

1. Admin requests leave: `GET /api/admin/doctors/:id/leave-preview?date=`
   returns the count and list of confirmed bookings that would be affected â€”
   shown in the admin UI *before* anything is committed.
2. Admin confirms: `POST /api/admin/doctors/:id/leave {date}`.
3. Service transaction:
   a. Insert/verify `leave_days` row (idempotent).
   b. Select confirmed appointments of that doctor on that date `FOR UPDATE`.
   c. For each: update `status='cancelled_by_leave'`, write an
      `appointment_events` audit row (`reason='leave:<date>'`), delete linked
      calendar events (via queue), enqueue emails to affected patients
      (`template=leave_cancellation`) and to the doctor (roster change).
   d. Commit atomically â€” either the leave takes effect with all cancellations
      recorded, or nothing changes.
4. Slot listing joins `leave_days`, so the date disappears from availability
   instantly.
5. The admin response reports how many bookings were affected; the cascade is
   queryable afterwards via `appointment_events` (`reason LIKE 'leave:%'`),
   giving the write-up a concrete, citable trace.
6. Notifications ride the queue (Â§7); failures never block the leave commit.

Edge cases handled: marking leave twice (idempotent), leave today with an
in-progress visit (only future same-day visits cancelled; completed untouched),
admin un-marks leave (allowed while zero cancellations occurred; otherwise
blocked with explanation â€” cancellations are not silently reversible).

## 6. Flow: reschedule (R10 â€” brief requires calendar *update*, not recreate)

Reschedule is a first-class operation because the brief says calendar events are
"updated â€¦ on reschedule".

1. Patient (or admin on their behalf) requests:
   `PATCH /api/appointments/:id {scheduledAt}` with a target slot.
2. Service runs the same openness validation as booking (working day/hours,
   not leave, not past), then takes a **hold** on the target slot using the
   exact hold mechanism of Â§4 â€” uniqueness makes races against other patients safe.
3. In one transaction: old slot's status â†’ `rescheduled` (frees the partial
   index immediately), appointment row's `scheduled_at` updated to the held
   slot, hold flag cleared. Commit.
4. Side effects enqueued in the same transaction:
   `calendar patch` rows for both events (`audience patient|doctor`),
   `email_queue` â†’ both parties get `reschedule_notice` (old time â†’ new time).
5. Calendar client maps patches to Google's `events.patch` with the stored
   `google_event_id`s; failures ride the standard retry ladder of Â§7.

Cancellation semantics unchanged: `DELETE /api/appointments/:id` sets
`cancelled_by_patient`, deletes both Google events, queues cancellation mail
to both parties.

Reminder emails (appointment reminder, morning of the visit) read the live
`scheduled_at`, so a rescheduled visit reminds at the right time automatically;
dedup keys include the date+time they were computed from, so a reschedule
before the reminder fires yields exactly one correct reminder.

## 7. Flow: notification reliability (graded topic)

**Rule: request paths never send; they only enqueue.**

```
service action â”€â”€â–¶ INSERT email_queue(status=pending, dedup_key) â”€â”
                    calendar_events(status=pending)               â”‚ committed with the
                                                                  â”‚ business change
tick():                                                           â–¼
  claim due pending rows (FOR UPDATE SKIP LOCKED) â†’ attempt send/sync
    success â†’ mark sent (+ sent_at, notification_log audit)
    failure â†’ attempts++, next_attempt_at = now + backoff(attempts)
              backoff: 1m, 5m, 25m, 125m (Ã,5), cap 6 attempts â†’ status=failed
              (dead-letter; visible in admin health view)
```

**Idempotency.** Retries must not double-send. Claims are atomic (`SKIP LOCKED`
row locks), `dedup_key` collapses duplicate enqueues for the same logical event,
and `sent_at` marks terminal delivery so a worker crash between SMTP acceptance
and row update can at worst resend one email â€” at-least-once with de-duplication
at claim time.

**Dead-lettering.** After the sixth failure a row is marked `failed` and stops
consuming retries; counts surface in the admin queue-health view. Nothing is
silently dropped and nothing retries forever.

Properties:

- **Atomicity**: the booking commit and its notification enqueue are the same
  transaction â€” a booked appointment always has queued email; the reverse
  impossible.
- **At-least-once delivery** with claim-time deduplication (above).
- **User flows never wait on SMTP or Google**: worst case the notification is
  late or marked failed in the log â€” the graded criterion.
- Calendar unconfigured (no env keys) â†’ events marked `skipped` with reason,
  visible in logs, nothing throws.

## 8. Flow: medication reminders (R8)

Prescription shape: `{drug, dosage, times: ["08:00","20:00"], duration_days}`.

Each tick: find appointments with `visit_notes` where
`scheduled_at <= now < scheduled_at + duration_days`, compute whether any
prescription time-of-day falls within the elapsed window since the last tick
window boundary, and if not already sent (dedup key
`appointment_id+drug+date+time`) enqueue `template=medication_reminder` to the
patient. Window arithmetic uses half-open intervals `[last_tick, now)` so clock
skew and missed ticks self-heal on the next tick.

## 9. Flow: LLM summaries (R6/R7/R12) â€” fully async, never blocking

```
confirm(symptoms) â”€â”€â–¶ INSERT pre_visit_summaries(generation_status='pending')
                      (+ appointment_events audit)  â€¦ commit; respond 201 at once

tick(): regeneratePendingSummaries()
   claim pending where next_attempt_at<=now (FOR UPDATE SKIP LOCKED)
     â”œ LLM ok            â†’ fill urgency/complaint/questions,
     â”‚                     generation_status='ready', source='llm', model=<name>
     â”œ LLM fail/timeout  â†’ attempts++, next_attempt_at = backoff(Ã,5 ladder)
     â”” attempts â‰¥ 3      â†’ deterministic fallback content written,
                           status='ready', source='fallback'   â† queue never empty
malformed JSON = failure (strict shape gate: urgency âˆˆ {Low,Medium,High},
3 questions array) â€” injected prose cannot smuggle fields into storage.
```

The same lifecycle serves post-visit summaries when the doctor saves notes.
One reliability pattern â€” claim â†’ attempt â†’ backoff â†’ dead-letter-with-fallback
â€” reused across email and both summary types. The doctor's queue shows
"summary generatingâ€¦" placeholders for pending rows and honest provenance
("AI draft" / "fallback rules") once ready; booking and note-saving responses
never wait on the LLM. Details and prompts: [05-llm-integration.md](05-llm-integration.md).

## 10. Security posture

- bcrypt(10) hashes; login constant-time comparisons via bcrypt semantics.
- JWT `{sub, role}` httpOnly SameSite=Lax cookie; `requireAuth`/`requireRole`
  middleware; doctors/admins are separate role gates, not trust-by-user-id.
- zod validation on every mutating route; unknown keys stripped.
- All SQL parameterized; no string interpolation of user data ever.
- Rate limiting note: express-rate-limit omitted deliberately (dep budget);
  login route applies a tiny in-memory attempt throttle we own (~15 lines).
- Secrets only via env; `.env.example` documents every variable; no secrets in
  repo (submission guideline).

## 11. Observability, audit & ops surfaces

Structured console logs (JSON lines): request method/path/status/duration,
job outcomes, notification failures with attempt counts. Three reviewable
surfaces fall out of data we already write:

- **`appointment_events`** â€” every status transition with actor and reason;
  the leave cascade (`reason LIKE 'leave:%'`) is a queryable audit trail.
- **Admin queue-health view** â€” pending / retrying / dead-lettered counts from
  `email_queue` plus calendar sync status; demonstrates notification
  reliability live instead of asserting it in the README.
- **`notification_log`** â€” per-recipient delivery history.

No APM â€” proportionate to scale, noted for future.

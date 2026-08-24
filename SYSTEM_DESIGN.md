# System Design

Four graded mechanics, each stated as an invariant, the mechanism that enforces
it, and how failures degrade.

## 1. Double-booking prevention

**Invariant:** a doctor never has two live appointments (`held` or `confirmed`)
at the same moment , even under simultaneous requests.

The enforcement point is the database, not application code:

```sql
CREATE UNIQUE INDEX uniq_appt_doctor_slot ON appointments (doctor_id, scheduled_at)
  WHERE status IN ('held', 'confirmed');
```

Booking is two phases. *Hold:* `INSERT … status='held'` inside a transaction;
if two requests race, Postgres lets one commit and aborts the other with
SQLSTATE 23505, which the service maps to HTTP 409 `SLOT_TAKEN`. *Confirm:* the
row transitions `held → confirmed` (symptoms written in the same transaction),
staying inside the same index predicate , so a confirmed row still blocks any
other live row at that instant. Verified under real parallel load:
`scripts/concurrency-proof.mjs` fires N simultaneous holds; output for N=16 is
embedded in the README (`created:1, slotTaken:15, liveHeldRows:1`). Reschedule
runs as `UPDATE … WHERE id=$1 AND patient_id=$2 AND status='confirmed'`
returning the row, so ownership and state are checked atomically before the
index re-validates the new time.

## 2. Doctor leave conflict handling

Admin marks leave in two steps. **Preview:** `GET /admin/doctors/:id/leave-preview?date=`
counts confirmed bookings on that date before anything changes.
**Commit:** one transaction inserts the `leave_days` row (idempotent via primary
key), updates that date's confirmed bookings to `cancelled_by_leave`, appends
`appointment_events` audit rows (reason `leave:<date>`), and enqueues
cancellation emails to both patient and doctor plus calendar deletions , all as
outbox rows. Slot generation joins against `leave_days`, so the date simply has
no open slots afterwards. Re-marking the same date cancels nothing (0 affected)
, safe retries by design.

## 3. Slot hold mechanism

While the patient fills the symptom form, their chosen slot must not be bookable
by others , but must not stay blocked forever either. Confirming a slot creates
an appointment row with `status='held'` and `hold_expires_at = now() + 5 min`.
The partial unique indexes give exactly the right semantics: one live hold per
doctor-slot (blocks everyone else) *and* one active hold per patient (a second
hold attempt → 409 `HOLD_EXISTS`, so holds can't be used to hoard slots).
If the form is abandoned, the minute-tick sweeper expires stale holds
(`status='expired'`, audit reason `hold_expired`), releasing the slot; the UI
shows a live countdown so expiry is never a surprise. Confirm requires an
unexpired own hold (`410 HOLD_EXPIRED` otherwise) and mandatory symptoms
(`422 SYMPTOMS_REQUIRED`) , booking without symptoms is structurally
impossible.

## 4. Notification failure handling

Nothing sends synchronously inside a request. Every email (confirmations,
cancellations, reschedule notices, medication reminders) is first written to
`email_queue` in the same transaction as the business change: the booking
cannot succeed without its notification being durably queued. A background
worker claims due rows with `FOR UPDATE SKIP LOCKED`, delivers via SMTP, and on
failure retries with exponential backoff (next_attempt_at = +1, +5, +25 min).
After three strikes the row is dead-lettered (`status='failed'`), which frees
its logical `dedup_key` so a retry of the underlying event can send fresh.
Claim-time checks make delivery at-most-once per logical event while retryable
(`dedup_key` unique index excludes failed rows; `sent_at` set in the same
update that flips status). Calendar sync follows the identical ladder in its
own table. The admin health view reports pending/failed depths and the last
scheduler tick, so dead letters are surfaced operationally , while user flows
continue untouched, because no request path ever depended on delivery
succeeding.

*(Word count: ~560.)*

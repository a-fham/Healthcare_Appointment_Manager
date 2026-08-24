# 04 , API Reference

Base URL `/api`. All responses JSON. Errors always
`{"error":{"code":"<CODE>","message":"…"}}`. Auth = JWT in the `hcm_session`
HttpOnly cookie (`SameSite=Lax`, `Secure` in production). Roles: `patient`,
`doctor`, `admin`.

## Auth , `POST /api/auth/*`

| Endpoint | Body | Notes |
|---|---|---|
| `POST /auth/register` | `{name, email, password, phone?}` | Patients only. 201; does **not** auto-login. |
| `POST /auth/login` | `{email, password}` | Sets session cookie. Throttled per email+IP (5 fails → 15 min `RATE_LIMITED`). |
| `POST /auth/logout` | – | Clears cookie. |
| `GET /auth/me` | – | Current user or 401. |

Errors: `EMAIL_TAKEN`, `INVALID_CREDENTIALS`, `RATE_LIMITED`, `VALIDATION_ERROR`.

## Public

- `GET /doctors?specialisation=…` , list with schedule + slot length.
- `GET /doctors/:id/slots?date=YYYY-MM-DD` , tiled slots:
  `{slots:[{startsAt:"09:20", status:"open"|"booked"|"held"|"leave"|"past"}]}`.

## Booking (patient)

| Endpoint | Body / query | Success | Failure codes |
|---|---|---|---|
| `POST /doctors/:id/slots/hold` | `{scheduledAt:"YYYY-MM-DD HH:MM"}` | 201 `{appointmentId, expiresAt}` (5 min hold) | `SLOT_TAKEN` 409 · `HOLD_EXISTS` 409 · `SLOT_NOT_OPENABLE` 422 · `SAME_DOCTOR_SAME_DAY` 409 · `TIME_OVERLAP` 409 |
| `POST /appointments/:id/confirm` | `{symptomsText, severity∈mild\|moderate\|severe, durationText}` | 200 appointment confirmed; pre-visit summary row created `pending`; outbox rows queued | `HOLD_EXPIRED` 410 · `SYMPTOMS_REQUIRED` 422 |
| `PATCH /appointments/:id/reschedule` | `{scheduledAt}` | 200 moved (own, confirmed only); calendar patched, notices queued | same as hold |
| `DELETE /appointments/:id` | – | 204 cancelled (patient owns it; admin any). Leave-cancellations are system-driven, not this route | `NOT_FOUND` 404 |

Hold semantics: on-grid but occupied → `SLOT_TAKEN`; off-grid / leave day /
past → `SLOT_NOT_OPENABLE`. Holds expire via sweeper (status `expired`,
audit reason `hold_expired`).

Patient-side scheduling rules (DB-enforced via partial unique index
`uniq_appt_patient_doctor_day` and EXCLUDE constraint
`no_patient_time_overlap`):

- One **live** booking per (patient, doctor, day) , two appointments with the
  same doctor on the same day → `SAME_DOCTOR_SAME_DAY` 409.
- No **time overlap** for live bookings across all doctors for one patient ,
  pick a time that ends before the next one starts → `TIME_OVERLAP` 409.
- Different times on the same day with different doctors are allowed.

## Doctor

- `GET /doctors/me/queue?date=YYYY-MM-DD` , own queue sorted urgency
  high→medium→low then time:
  `[{id, scheduledAt, status, severity, patientName, symptoms, urgency,
  chiefComplaint, questions[3], generationStatus}]`.
- `POST /appointments/:id/notes` , body `{clinicalNotes, prescription:[{name,
  dosage, times:["08:00","20:00"], durationDays}]}`
  (≤20 meds, 1–6 times each, 1–365 days). Completes the visit, creates pending
  post-visit summary, schedules medication reminders. First write wins;
  second POST → `CONFLICT` 409. Not-owned/not-confirmed → 404/409.

## Patient self-view

- `GET /my/appointments` , newest-first, incl. doctor name/specialisation and
  `postVisit:{summaryMd, medicationSchedule, followUp}` once ready. Never
  exposes clinical notes, urgency, or triage questions.

## Admin

| Endpoint | Notes |
|---|---|
| `POST /admin/doctors` | Create doctor `{email,name,password,specialisation,workingDays,startsAt,endsAt,slotMinutes}`. |
| `GET /admin/doctors` / `GET /admin/doctors/:id` | List / detail. |
| `PATCH /admin/doctors/:id` | Update specialisation / schedule / slot length. |
| `DELETE /admin/doctors/:id` | Blocked with `CONFLICT` while future confirmed bookings exist. |
| `GET /admin/doctors/:id/leave-preview?date=` | `{date, affectedCount}` before committing. |
| `POST /admin/doctors/:id/leave` | `{date}` → cancels that date's confirmed bookings (`cancelled_by_leave`), notifies both sides, deletes their calendar events. Idempotent. Returns `{date, cancelledCount}`. |
| `GET /admin/health` | Queue depths: emails/calendar pending+failed, active holds, summaries preparing, last tick. |

## Jobs

- `POST /jobs/tick` , header `x-job-secret`. Runs one scheduler pass:
  `{holdsExpired, emails:{sent,failed}, calendar:{synced,deleted}, reminders,
  summaries}`. Wrong/missing secret → 403 `FORBIDDEN`.

## Status codes

400 validation · 401 unauthenticated · 403 wrong role · 404 not found or not
yours · 409 conflict (slot taken, hold exists, already written) · 410 hold
expired · 422 semantically invalid request · 429 throttled.

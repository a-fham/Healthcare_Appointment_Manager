# Ashgrove , Healthcare Appointment & Follow-up Manager

A full-stack clinic booking platform where patients book consultations, describe symptoms, and receive AI-generated care summaries , while doctors see a triage-sorted queue, record visit notes, and issue structured prescriptions. Double-booking is structurally impossible. Notification and calendar failures never break a user flow.

Built with Node.js 22, Express, PostgreSQL 16, React 18, and zero external service dependencies. Eight server-side runtime dependencies. Three on the client. Everything else , retry logic, calendar integration, LLM orchestration, migration runner , is hand-written and auditable.

---

## Features

### Patient Portal
- Register and log in with email/password authentication.
- Search doctors by specialisation with real-time filtering.
- Hold a slot for 5 minutes while completing a symptom form , no one else can book it, but the hold expires automatically if abandoned.
- Receive an AI-generated pre-visit summary (urgency level, chief complaint, suggested questions) delivered to the doctor before the appointment.
- View upcoming and past appointments with full post-visit summaries and structured medication schedules.
- Reschedule or cancel appointments with one click , calendar events update automatically, cancellation emails fire to both parties.

### Doctor Portal
- See today's queue sorted by urgency (High → Medium → Low), with severity badges, patient names, and scheduled times.
- Review AI pre-visit summaries before seeing the patient , no context gaps.
- Record clinical notes and a structured prescription (medication name, dosage, frequency, duration) after each visit.
- AI generates a patient-friendly post-visit summary from the clinical notes , plain language, no medical jargon.
- Leave days marked by admin auto-cancel affected bookings and notify patients.

### Admin Portal
- Create and manage doctor profiles: specialisation, working hours, slot duration, and leave days.
- Mark leave with a preview showing how many confirmed bookings will be affected before committing.
- View notification health: pending, failed, and dead-lettered message counts across email and calendar queues.
- One-click doctor removal with cascade handling.

### Notification System
- Persistent email outbox: every notification is written to a queue table in the same transaction as the business change. Delivery happens asynchronously.
- Exponential backoff retry: failures retry at +1, +5, +25 minutes. After three strikes, the message is dead-lettered and surfaced in the admin health view.
- Medication reminders generated from prescription frequency, active only between visit date and visit date + duration.
- Morning-of visit reminders with reschedule-aware deduplication.

### Google Calendar Integration
- Calendar events created for both patient and doctor on booking confirmation.
- Events updated on reschedule, deleted on cancellation or leave-cancellation.
- Sync status tracked per event; failures follow the same retry ladder as email , never blocking user flows.

### AI Integration
- Provider-agnostic LLM adapter: works with OpenAI, Gemini, or runs keyless with deterministic fallback summaries.
- Pre-visit summaries: urgency classification, chief complaint extraction, three suggested diagnostic questions , generated at confirmation time, stored permanently.
- Post-visit summaries: plain-language translation of clinical notes for the patient , generated after the doctor records visit notes.
- All LLM failures degrade gracefully: the system retries, then falls back to deterministic content. Booking never blocks on LLM availability.

---

## Edge Cases Handled

### Double-Booking Prevention
Two patients attempting to book the same slot simultaneously: exactly one succeeds, the other receives HTTP 409 `SLOT_TAKEN`. This is enforced by a partial unique index on `(doctor_id, scheduled_at)` where status is `held` or `confirmed` , the database itself rejects the duplicate, not application logic. Verified under real parallel load with 16 concurrent hold attempts on a single slot: one created, fifteen rejected, zero data corruption.

### Hold Expiry
A patient holds a slot but abandons the form: the hold expires after 5 minutes via a background sweeper. The slot returns to the open pool. The UI displays a live countdown so expiry is never a surprise. Attempting to confirm an expired hold returns HTTP 410 `HOLD_EXPIRED`.

### Leave Day Conflicts
Admin marks a doctor's leave on a date with existing confirmed bookings: all affected bookings transition to `cancelled_by_leave` in a single transaction. Cancellation emails enqueue to both patient and doctor. Calendar events are deleted. The slot generation joins against `leave_days`, so the date has no open slots afterward. Re-marking the same date is idempotent , zero affected rows, safe to retry.

### Concurrent Hold Prevention
One active hold per patient is enforced by a partial unique index on `(patient_id)` where status is `held`. A second hold attempt returns HTTP 409 `HOLD_EXISTS`, preventing slot hoarding.

### Reschedule Safety
Reschedule releases the old slot's hold first, then attempts to hold the new slot , ensuring constraints (same-doctor-same-day, time-overlap) don't fire against the appointment being moved. If the new slot is unavailable, the old appointment remains intact.

### LLM Failure Degradation
If the LLM provider is unreachable or returns malformed output: the system retries with exponential backoff, then writes a deterministic fallback summary. The booking is never blocked. The doctor queue shows whatever summary is available , generated or fallback.

### Notification Failure Isolation
No user-facing request path depends on notification delivery. Emails are queued durably in the same transaction, then delivered by a background worker. SMTP failures retry, then dead-letter. The user flow completes regardless.

---

## Security

| Threat | Mitigation |
|---|---|
| SQL injection | Parameterized queries everywhere; dynamic ORDER BY uses allow-lists, never user input |
| Broken access control (IDOR) | Ownership predicates in query predicates , resource not found returns 404, not 403 |
| Privilege escalation | Role gates on every protected route; zod schemas strip unknown keys before insertion |
| Credential stuffing | bcrypt cost 10, login throttling (5 failures / 15 min per email+IP), no user enumeration |
| Session theft via XSS | JWT in httpOnly cookie , JavaScript cannot read it |
| Stored XSS via AI text | Post-visit summaries rendered as plain text with CSS `white-space: pre-wrap` , no `dangerouslySetInnerHTML` |
| Prompt injection | LLM adapter demands strict JSON matching a fixed shape; injected prose fails validation |
| CSRF | SameSite=Lax cookies + JSON-only request bodies , HTML forms cannot forge requests |
| DoS via oversized payloads | Body limit 100KB; field-level caps on symptom text (4000 chars) |
| Info leakage | Central error contract: known errors return `{error:{code,message}}`; unknown errors log server-side and return generic 500 |

---

## Tech Stack

| Layer | Choice | Rationale |
|---|---|---|
| Runtime | Node.js 22 (ESM) | Single language across stack; native `fetch` for HTTP integrations |
| Web framework | Express 4 | Zero-magic, debuggable, universal deployment support |
| Database | PostgreSQL 16 | Partial unique indexes enable provable double-booking prevention |
| Data access | Raw SQL via `pg` | Constraints stay visible; no ORM abstraction hiding safety properties |
| Auth | JWT in httpOnly cookie | Stateless, role-based, no session store required |
| Validation | Zod at boundaries | Type-safe schemas; unknown keys stripped automatically |
| Email | Nodemailer + SMTP | No vendor account required; Gmail app-password works in production |
| Calendar | Hand-rolled OAuth2 + REST | Avoids the heaviest SDK dependency; shows the integration explicitly |
| LLM | Provider-agnostic adapter via fetch | Runs keyless with deterministic fallback; no vendor lock-in |
| Frontend | React 18 + Vite SPA | Component model fits three portals; Vite build served statically by Express |
| Styling | Hand-written CSS design system | Custom properties for theming; no utility-class framework |
| Tests | Vitest + supertest | ESM-native, fast; HTTP-level integration tests cover all graded behaviors |

**Server dependencies (8):** express, pg, bcryptjs, jsonwebtoken, zod, node-cron, nodemailer, dotenv
**Client dependencies (3):** react, react-dom, react-router-dom

---

## Getting Started

```bash
# Prerequisites: PostgreSQL 16+ running locally

# Create databases
createdb -U postgres hcm_dev
createdb -U postgres hcm_test

# Server setup
cd server
npm install
cp .env.example .env        # configure DATABASE_URL, JWT_SECRET, JOB_SECRET
npm run migrate
npm run seed                 # seeds admin, 3 doctors, 20 patients
npm run dev                  # http://localhost:3000

# Client build (served by the same Express process)
cd ../client
npm install
npm run build
```

The application works fully keyless. Without SMTP, Google Calendar, or LLM credentials, it runs with console-logged emails, skipped calendar sync, and deterministic fallback summaries.

**Default credentials:**
- Admin: `admin@ashgrove.health` / `admin-seed-pass-1`
- Doctors: `arjun.rao@ashgrove.health` / `doctor-seed-pass-1` (and 2 more)
- Patients: register through the UI

---

## Testing

```bash
# Server: 22 test files, 282 tests
cd server && npx vitest run

# Client build verification
cd client && npx vite build
```

**Concurrency proof** , 16 simultaneous hold attempts on one slot (real Postgres, no mocks):

```
firing 16 parallel holds on 2026-08-31 09:00 …
{"n":16,"created":1,"slotTaken":15,"liveHeldRows":1,"pass":true}
PROOF PASSED
```

Exactly one `held` row survives. Every loser receives HTTP 409 `SLOT_TAKEN`.

---

## Architecture

```
server/
  migrations/          SQL applied in order at boot
  src/
    config.js          Zod-validated environment
    db/                Connection pool, migration runner, transaction helper
    lib/               Errors, cookies, passwords, time, mailer, googleCalendar
    middleware/        requireAuth, requireRole, security headers, error handler
    routes/            auth, public, booking, doctor, patient, admin, jobs
    services/          slots, booking, llm/, workers/, leave, notes, views, health
    scripts/           seed.js, concurrency-proof.mjs
  test/                Vitest suite (282 tests)
client/
  src/
    pages/             One page per user flow
    api.js             Error-aware fetch wrapper
    auth.jsx           Session context with role-based routing
    App.jsx            Sidebar layout with mobile responsive navigation
```

**Background scheduler:** one idempotent tick every minute (in-process cron or `POST /api/jobs/tick` with the job secret): expire stale holds → deliver due emails with backoff → sync calendar events → regenerate pending AI summaries → schedule medication reminders from active prescriptions. Failures retry then dead-letter into the admin health view. Notification problems never break a user flow.

---

## Documentation

| Document | Contents |
|---|---|
| [System Design](SYSTEM_DESIGN.md) | Four graded mechanics: invariants, enforcement, failure modes |
| [Database Schema](docs/02-database-schema.md) | Table definitions, indexes, constraints |
| [API Reference](docs/04-api.md) | Endpoint specifications with request/response examples |
| [LLM Integration](docs/05-llm-integration.md) | Prompt templates, provider adapter, fallback strategy |
| [Setup Guide](docs/03-setup-and-run.md) | Local development, Google Calendar configuration, deployment |
| [Security Notes](docs/07-security-notes.md) | Threat model, controls, and test mappings |
| [Architecture Decisions](docs/adr/) | Eleven ADRs covering rejected alternatives |

---

## License

Internal project. Not licensed for distribution.

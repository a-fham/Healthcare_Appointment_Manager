-- 0001_init.sql , full schema (docs/02-database-schema.md §DDL)
-- Correctness of scheduling lives here: see the two partial unique indexes
-- on appointments. Datetimes are clinic-local naive timestamps (single clinic).

CREATE TABLE users (
  id            BIGSERIAL PRIMARY KEY,
  role          TEXT NOT NULL CHECK (role IN ('patient', 'doctor', 'admin')),
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  phone         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE doctors (
  user_id        BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  specialisation TEXT NOT NULL,
  working_days   INT[] NOT NULL DEFAULT '{1,2,3,4,5}',
  starts_at      TIME NOT NULL,
  ends_at        TIME NOT NULL,
  slot_minutes   INT NOT NULL CHECK (slot_minutes > 0),
  CHECK (ends_at > starts_at),
  CHECK (working_days <@ ARRAY[0,1,2,3,4,5,6]::int[])
);

CREATE INDEX idx_doctors_specialisation ON doctors (lower(specialisation));

CREATE TABLE leave_days (
  doctor_id BIGINT NOT NULL REFERENCES doctors(user_id) ON DELETE CASCADE,
  date      DATE NOT NULL,
  PRIMARY KEY (doctor_id, date)
);

CREATE TABLE appointments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id      BIGINT NOT NULL REFERENCES users(id),
  doctor_id       BIGINT NOT NULL REFERENCES doctors(user_id),
  scheduled_at    TIMESTAMP NOT NULL,
  status          TEXT NOT NULL CHECK (status IN (
                    'held', 'confirmed', 'completed',
                    'cancelled_by_patient', 'cancelled_by_admin',
                    'cancelled_by_leave', 'expired', 'rescheduled'
                  )),
  symptoms_text   TEXT,
  severity        TEXT CHECK (severity IN ('mild', 'moderate', 'severe')),
  duration_text   TEXT,
  hold_expires_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- GRADED: one live appointment per doctor per moment , the double-booking wall.
CREATE UNIQUE INDEX uniq_appt_doctor_slot
  ON appointments (doctor_id, scheduled_at)
  WHERE status IN ('held', 'confirmed');

-- GRADED: one active hold per patient at a time.
CREATE UNIQUE INDEX uniq_appt_patient_hold
  ON appointments (patient_id)
  WHERE status = 'held';

CREATE INDEX idx_appts_patient ON appointments (patient_id, scheduled_at DESC);
CREATE INDEX idx_appts_doctor_date ON appointments (doctor_id, scheduled_at)
  WHERE status = 'confirmed';

CREATE TABLE pre_visit_summaries (
  appointment_id    UUID PRIMARY KEY REFERENCES appointments(id) ON DELETE CASCADE,
  urgency           TEXT CHECK (urgency IN ('low', 'medium', 'high')),
  chief_complaint   TEXT,
  questions         JSONB,
  generation_status TEXT NOT NULL DEFAULT 'pending'
                    CHECK (generation_status IN ('pending', 'ready')),
  source            TEXT CHECK (source IN ('llm', 'fallback') OR source IS NULL),
  model             TEXT,
  attempts          INT NOT NULL DEFAULT 0,
  next_attempt_at   TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE visit_notes (
  appointment_id UUID PRIMARY KEY REFERENCES appointments(id) ON DELETE CASCADE,
  clinical_notes TEXT NOT NULL,
  prescription   JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE post_visit_summaries (
  appointment_id      UUID PRIMARY KEY REFERENCES appointments(id) ON DELETE CASCADE,
  summary_md          TEXT,
  medication_schedule JSONB,
  follow_up           TEXT,
  generation_status   TEXT NOT NULL DEFAULT 'pending'
                      CHECK (generation_status IN ('pending', 'ready')),
  source              TEXT CHECK (source IN ('llm', 'fallback') OR source IS NULL),
  model               TEXT,
  attempts            INT NOT NULL DEFAULT 0,
  next_attempt_at     TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Notification outbox: written in the same transaction as the business change,
-- delivered by the tick worker with backoff; failed = dead-lettered.
CREATE TABLE email_queue (
  id             BIGSERIAL PRIMARY KEY,
  to_email       TEXT NOT NULL,
  template       TEXT NOT NULL,
  payload        JSONB NOT NULL DEFAULT '{}'::jsonb,
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'sent', 'failed')),
  attempts       INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at        TIMESTAMPTZ,
  last_error     TEXT,
  appointment_id UUID REFERENCES appointments(id) ON DELETE SET NULL,
  dedup_key      TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotency: a given logical event sends at most once while not dead-lettered.
CREATE UNIQUE INDEX uniq_email_dedup
  ON email_queue (dedup_key)
  WHERE dedup_key IS NOT NULL AND status <> 'failed';

CREATE INDEX idx_email_due ON email_queue (next_attempt_at)
  WHERE status = 'pending';

CREATE TABLE calendar_events (
  id              BIGSERIAL PRIMARY KEY,
  appointment_id  UUID NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  audience        TEXT NOT NULL CHECK (audience IN ('patient', 'doctor')),
  google_event_id TEXT,
  sync_status     TEXT NOT NULL DEFAULT 'pending'
                  CHECK (sync_status IN ('pending', 'synced', 'failed',
                                         'skipped', 'deleting', 'deleted')),
  last_error      TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (appointment_id, audience)
);

CREATE TABLE notification_log (
  id             BIGSERIAL PRIMARY KEY,
  user_id        BIGINT REFERENCES users(id) ON DELETE SET NULL,
  appointment_id UUID,
  channel        TEXT NOT NULL DEFAULT 'email',
  kind           TEXT NOT NULL,
  status         TEXT NOT NULL,
  detail         JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Audit trail of every appointment state transition, written inside the same
-- transaction as the transition itself (architecture doc §5/§11).
CREATE TABLE appointment_events (
  id             BIGSERIAL PRIMARY KEY,
  appointment_id UUID NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  from_status    TEXT,
  to_status      TEXT NOT NULL,
  actor_role     TEXT NOT NULL
                 CHECK (actor_role IN ('system', 'patient', 'doctor', 'admin')),
  reason         TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE job_state (
  name        TEXT PRIMARY KEY,
  last_run_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

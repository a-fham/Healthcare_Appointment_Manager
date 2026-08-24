-- 0003_booking_overlap_constraints.sql
-- Two business rules, enforced at the DB level so concurrent transactions
-- cannot slip past an application-level check:
--
--   1. One LIVE booking per (patient, doctor, calendar day).
--      (held or confirmed → blocked; cancelled/expired/rescheduled → free)
--      Rationale: a patient should not have two live slots with the same
--      doctor on the same day , pick one or cancel the other first.
--
--   2. No time overlap for LIVE bookings across all doctors for one patient.
--      (held or confirmed → blocked)
--      Rationale: a patient cannot be in two places at once.
--
-- Both constraints are PARTIAL: only rows with status in ('held','confirmed')
-- count. Cancelled / completed / expired / rescheduled rows drop out of the
-- predicate and free the slot/overlap immediately.
--
-- Implementation notes:
-- * The overlap end-time is stored as `overlap_until` (TIMESTAMPTZ) and is
--   maintained by a BEFORE INSERT/UPDATE trigger that looks up the doctor's
--   slot_minutes. We can't use a STORED generated column here because PG
--   disallows subqueries against other tables in generated expressions.
-- * btree_gist is required so a GIST EXCLUDE can include the btree-keyable
--   patient_id alongside the range.
-- * scheduled_at is naive TIMESTAMP (clinic-local); we cast to timestamptz
--   inside the constraint to give the planner a single canonical type.

-- -----------------------------------------------------------------------
-- Rule 1: one live booking per (patient, doctor, day)
-- -----------------------------------------------------------------------
CREATE UNIQUE INDEX uniq_appt_patient_doctor_day
  ON appointments (patient_id, doctor_id, (scheduled_at::date))
  WHERE status IN ('held', 'confirmed');

-- -----------------------------------------------------------------------
-- Rule 2: no time overlap for one patient across all doctors
-- -----------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE appointments ADD COLUMN overlap_until TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION appointments_set_overlap_until() RETURNS TRIGGER AS $$
DECLARE
  slot_min INTEGER;
BEGIN
  SELECT d.slot_minutes INTO slot_min
    FROM doctors d
   WHERE d.user_id = NEW.doctor_id;
  IF slot_min IS NULL THEN
    -- No matching doctor row , leave as NULL so the EXCLUDE doesn't fire.
    -- The FK from appointments.doctor_id → doctors.user_id will block the
    -- insert anyway, so reaching here is impossible in practice.
    NEW.overlap_until := NULL;
  ELSE
    NEW.overlap_until := NEW.scheduled_at::timestamptz + (slot_min || ' minutes')::interval;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_appointments_set_overlap_until
  BEFORE INSERT OR UPDATE OF doctor_id, scheduled_at ON appointments
  FOR EACH ROW EXECUTE FUNCTION appointments_set_overlap_until();

-- Backfill any existing rows (idempotent for fresh installs since the column
-- is NULL and the trigger handles all writes from here on).
UPDATE appointments a
   SET overlap_until = a.scheduled_at::timestamptz + (
         (SELECT d.slot_minutes FROM doctors d WHERE d.user_id = a.doctor_id)
         || ' minutes'
       )::interval
 WHERE a.overlap_until IS NULL;

ALTER TABLE appointments ALTER COLUMN overlap_until SET NOT NULL;

-- Immutable wrapper so the EXCLUDE can reference scheduled_at in a range.
CREATE OR REPLACE FUNCTION appt_range(ts TIMESTAMP, overlap TIMESTAMPTZ)
  RETURNS tstzrange IMMUTABLE AS $$
  SELECT tstzrange(ts::timestamptz, overlap, '[)');
$$ LANGUAGE sql;

ALTER TABLE appointments
  ADD CONSTRAINT no_patient_time_overlap
  EXCLUDE USING gist (
    patient_id WITH =,
    appt_range(scheduled_at, overlap_until) WITH &&
  )
  WHERE (status IN ('held', 'confirmed'));

-- Inspection view (should be empty by construction once constraints are live).
CREATE OR REPLACE VIEW v_live_overlap_violations AS
SELECT a1.id AS appt_a, a2.id AS appt_b, a1.patient_id,
       a1.scheduled_at AS a_at, a1.overlap_until AS a_end,
       a2.scheduled_at AS b_at, a2.overlap_until AS b_end
FROM appointments a1
JOIN appointments a2
  ON a1.patient_id = a2.patient_id
 AND a1.id <> a2.id
 AND a1.status IN ('held','confirmed')
 AND a2.status IN ('held','confirmed')
 AND appt_range(a1.scheduled_at, a1.overlap_until)
     && appt_range(a2.scheduled_at, a2.overlap_until);

# CONTEXT.md , Domain Glossary

Single source of truth for domain vocabulary. No implementation details live here.
If a term is missing or ambiguous in review, raise it , this file is updated the
moment a term is resolved, never batched.

---

## People

**Patient**
A person who registers to book consultations. Owns their appointments and symptom
submissions. Never sees clinical shorthand meant for doctors.

**Doctor**
A clinic practitioner with a specialisation, working hours, a slot duration, and
leave days. Logs in to see their queue. Created and managed by the Admin (doctors
do not self-register).

**Admin / Front desk**
Clinic staff who manage doctor profiles, mark leave days, and oversee bookings.
One admin account seeds the system.

## Time & Capacity

**Working hours**
The window of a doctor's day (e.g., 09:00–13:00) during which slots exist.
Defined per doctor together with **working days** (e.g., Mon–Fri).

**Slot duration**
The fixed length of one appointment for a given doctor (e.g., 20 minutes).
Slots tile the working hours: 09:00, 09:20, 09:40 …

**Slot instance**
One concrete `(doctor, date+time)` slot. A slot is *open* unless it is past,
outside working hours, on a leave day, held, or booked.

**Hold**
A short-lived reservation of an open slot created while a patient fills the
symptom form. Expires automatically (5 minutes). A hold blocks others from
booking that slot but is not yet an appointment. One active hold per patient.

**Booking / Appointment**
A confirmed reservation of a slot, carrying symptoms, a pre-visit summary, and
later visit notes and a post-visit summary. An appointment has exactly one
patient and one doctor at one `scheduled_at` moment.

**Double-booking**
Two confirmed appointments for the same doctor at the same `scheduled_at`.
The system must make this impossible, including under simultaneous requests.

**Leave day**
A date on which a doctor will not work. Marked by the Admin. Marking leave on a
date with existing confirmed bookings triggers **affected-booking handling**:
those bookings are cancelled by the system and patients are notified.

## Language

**Summary language**
The language a pre-visit or post-visit summary is delivered in. v1 ships
English only (the clinic's language of record); other languages are a
documented roadmap extension since generation is AI-driven.

## Clinical Record

**Symptom form**
What the patient fills before confirming a booking: free-text description,
perceived severity, how long symptoms have lasted. Required , booking without
symptoms is not possible.

**Pre-visit summary**
An AI-generated brief for the doctor, produced from the symptom form at
confirmation time. Contains: urgency level, chief complaint, three suggested
questions. Stored permanently; shown in the doctor's queue.

**Urgency level**
Triage signal attached to every pre-visit summary: `Low`, `Medium`, or `High`.
Derived by the AI from symptoms; used to sort the doctor's queue. It is
decision *support* only , never presented as a diagnosis.

**Chief complaint**
The one-line main reason for the visit, extracted into the pre-visit summary.

**Visit notes (clinical notes)**
Free-text notes plus a structured prescription the doctor records after seeing
the patient. Written in clinical language; not shown to the patient as-is.

**Prescription**
Structured list of medications: name, dosage, frequency times-of-day (e.g.,
08:00 & 20:00), duration in days. Drives medication reminders.

**Post-visit summary**
An AI-generated plain-language version of the visit notes for the patient:
what was found, the medication schedule, follow-up steps. Stored permanently.

**Medication reminder**
An email generated from a prescription's frequency times while the prescription
is active (between visit date and visit date + duration). Delivered via the
email queue.

## Messaging

**Notification outbox**
Persistent queue table for every outbound message. Messages are written here
first, then delivered by a background worker with retries. Nothing sends
synchronously inside a request.

**Notification failure**
Any notification operation that errors. Failures are retried with backoff;
after exhausting retries they are marked failed (dead-letter) and surfaced in
logs and the admin health view , the user flow never breaks because a
notification failed.

**Calendar event**
Google Calendar entries created for both patient and doctor on confirmation,
updated on reschedule, deleted on cancellation/leave-cancellation. Sync status
is tracked per event; calendar failures follow the same retry ladder as any
notification failure.

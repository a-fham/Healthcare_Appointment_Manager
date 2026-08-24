# PostgreSQL over MongoDB for the datastore

We decided on PostgreSQL (free tier on Neon) accessed with plain SQL through
`node-postgres`. The deciding factor is the double-booking requirement: it must
be *impossible*, including under simultaneous requests, and Postgres gives us a
partial unique index plus transactional isolation to make that a database-level
guarantee rather than an application-level hope.

## Why

- **The core invariant is relational.** "One confirmed appointment per doctor
  per time" is a constraint over rows, not a document shape. In MongoDB the
  best you get per free tier is one-document transactions via a replica set;
  enforcing uniqueness of `(doctor_id, scheduled_at)` among active bookings
  requires either application locking or a hand-built unique index , both
  weaker guarantees than `CREATE UNIQUE INDEX ... WHERE status IN (...)`.
- **The evaluation explicitly grades schema design.** Foreign keys, enums,
  partial indexes, and constraints are the vocabulary they want to see.
- **Reporting queries are trivial.** Doctor queues sort by urgency + time;
  SQL joins do this in one query.

## Considered options

- **MongoDB Atlas free tier** , rejected: no partial unique index equivalent
  without replica-set transactions; schema discipline would live only in code.
  Fine for document-shaped data; our data is schedule-shaped.
- **SQLite** , rejected: strongest concurrency story locally but awkward for a
  hosted demo and weaker evidence of production-grade schema skills.

## Consequences

- We depend on a hosted Postgres for the demo. Neon's free tier has no cold-sleep
  problem for this scale, unlike some alternatives.
- See ADR-0003 for why we talk to it with raw SQL.

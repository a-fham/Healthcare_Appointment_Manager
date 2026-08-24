# ADRs , Decision Log Index

Decisions are recorded as short Architecture Decision Records using sequential numbering.
Each records what was decided, why, and which alternatives were considered and rejected.

| # | Decision | Status |
|---|----------|--------|
| [0001](0001-monorepo-server-client.md) | Monorepo with `server/` and `client/` packages | Accepted |
| [0002](0002-postgresql-over-mongodb.md) | PostgreSQL over MongoDB for the datastore | Accepted |
| [0003](0003-raw-sql-over-orm.md) | Raw SQL via `node-postgres` over an ORM | Accepted |
| [0004](0004-express-monolith-over-serverless.md) | Long-running Express monolith over serverless/Next.js | Accepted |
| [0005](0005-jwt-httponly-cookie-auth.md) | JWT in httpOnly cookie for role-based auth | Accepted |
| [0006](0006-provider-agnostic-llm-via-fetch.md) | Provider-agnostic LLM adapter over native `fetch` | Accepted |
| [0007](0007-handrolled-google-calendar-rest.md) | Hand-rolled Google Calendar REST client over `googleapis` SDK | Accepted |
| [0008](0008-inprocess-scheduler-with-tick-endpoint.md) | In-process `node-cron` scheduler plus protected `/jobs/tick` endpoint | Accepted |
| [0009](0009-unified-multichannel-outbox.md) | Unified multi-channel notification outbox (email + SMS via Twilio) over parallel queues | Superseded by ADR-0011 |
| [0010](0010-dependents-visit-subject-model.md) | Dependents: account-holder vs visit-subject split | Superseded by ADR-0011 |
| [0011](0011-scope-discipline-defer-extensions.md) | Scope discipline: feature extensions deferred to roadmap; depth over breadth on graded axes | Accepted |

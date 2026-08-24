# In-process `node-cron` scheduler plus protected `/jobs/tick` endpoint

We decided that all recurring work , expiring holds, dispatching the email
queue, generating due medication reminders, retrying failed notifications,
sweeping stale calendar syncs , runs from a single `tick()` function invoked by
`node-cron` every minute inside the web process, and additionally exposed as
`POST /api/jobs/tick` guarded by a shared secret so an external cron (e.g.,
cron-job.org) can drive it when the host sleeps.

## Why

- One tick function means one idempotent unit of work to reason about, test,
  and re-run. Every job is "scan for due rows in Postgres and act" , safe to
  overlap because each step claims rows atomically (`FOR UPDATE SKIP LOCKED`
  or status guards) before acting.
- Free-tier hosts sleep idle services. The external-tick endpoint is the honest
  mitigation: even if node-cron never fires while asleep, cron-job.org hitting
  `/jobs/tick` every 5 minutes keeps reminders flowing. Both drivers share the
  same code path, so behavior is identical locally and deployed.
- BullMQ + Redis was overkill: it buys multi-consumer throughput we don't need
  and adds an infrastructure dependency on a free-tier budget.

## Considered options

- **BullMQ/Redis** , proper queues with rate control; rejected: extra service
  to host, violates minimal-dependency spirit, solves scale problems this app
  doesn't have.
- **Vercel Cron** , daily-only granularity on Hobby; disqualified by reminder
  precision needs.
- **setInterval** , fine in principle but node-cron expresses clinic-time
  schedules ("minute 0 of hours 8 and 20") directly and survives clock drift
  better than interval accumulation.

## Consequences

- Jobs are coupled to process uptime (mitigated by the tick endpoint).
- All job logic is pure-ish functions over the DB → straightforward TDD:
  seed rows, run `tick()`, assert side effects.

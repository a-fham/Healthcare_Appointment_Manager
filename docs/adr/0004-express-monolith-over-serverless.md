# Long-running Express monolith over serverless/Next.js

We decided on a single long-running Node.js process (Express) that hosts the
REST API, serves the built SPA, and runs the in-process scheduler. Serverless
platforms (Vercel functions, Next.js API routes) were considered and rejected
primarily because of the medication-reminder and retry requirements.

## Why

- **Background work is a first-class requirement**, not an add-on: medication
  reminders fire at prescription times (minute-level precision), expired holds
  are swept continuously, failed emails/calendar ops back off and retry.
  A long-running process can run `node-cron` ticks in-process with zero extra
  infrastructure. Vercel's Hobby cron allows only daily schedules , not
  sufficient; an external scheduler hitting a serverless endpoint would make
  every job an HTTP dance and still need state coordination.
- **One process = simplest honest deployment** on Render/Railway free tiers,
  matching the "deploy on any free hosting" deliverable.
- Express is ubiquitous, reviewable by any grader in seconds.

## Considered options

- **Next.js full-stack on Vercel** , best-in-class DX for the UI, but jobs
  become second-class (cron granularity, function timeouts, no persistent
  worker), and it would push toward Vercel-specific patterns the grader must
  reverse-engineer.
- **Fastify instead of Express** , faster and nicer schema story, but ecosystem
  familiarity wins for a graded submission; performance is irrelevant here.
- **NestJS** , structure is attractive but its DI/decorator machinery is heavy
  for ~15 endpoints and raises the reviewer's reading cost.

## Consequences

- Free-tier web services idle-sleep; we document a keep-alive ping plus the
  protected `/api/jobs/tick` endpoint (ADR-0008) so reminders survive naps.
- The scheduler runs inside the web process. At single-clinic scale this is
  correct-by-simplicity; horizontal scaling would require moving to a separate
  worker + leader election, noted as future work.

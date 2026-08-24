---
status: superseded by ADR-0011 (scope discipline , see ROADMAP.md)
---

# Unified multi-channel notification outbox (email + SMS) over parallel queues

We decided to generalize the planned `email_queue` into a single `notifications`
outbox carrying a `channel` column (`email` | `sms`), dispatched by the same
tick worker with one shared backoff ladder. SMS goes through Twilio's REST API
over native `fetch` â€” the same dependency-free adapter pattern as the Google
Calendar client (ADR-0007). WhatsApp Business messaging is documented as a
same-interface upgrade but deliberately out of v1 scope.

## Why

- The population this product serves books for parents and elders who may not
  monitor email; a second delivery channel is the highest-leverage usability
  extension available, and it slots into architecture that already treats all
  outbound effects as queued work.
- One table, one worker, one backoff policy â€” versus two queues duplicating
  claim/backoff/dedup logic. The graded "notification failure handling" story
  stays a single mechanism to test and audit.
- Twilio chosen over Gupshup for v1: simplest REST surface, trial tier works
  for demos (verified numbers), no onboarding friction. The adapter interface
  (`send(channel, to, template, payload)`) keeps Gupshup/WhatsApp swappable.
- Real WhatsApp requires Meta business verification no student deployment can
  complete; documenting the path honestly beats faking it.

## Considered options

- **Parallel `sms_queue` table** â€” rejected: duplicated retry machinery, two
  audit surfaces, drift risk between ladders.
- **Gupshup first** â€” India-focused and WhatsApp-strong, but heavier onboarding;
  revisit at real-deployment time.
- **Third-party multi-channel SDK** (e.g., notification frameworks) â€” violates
  the locked dependency budget; hides the failure ladder being evaluated.

## Consequences

- Unconfigured SMS provider â†’ rows marked `skipped` with reason; email always
  remains the guaranteed channel, so the brief's email requirement is never
  weakened by the extension.
- Patient channel preference gates SMS per user; defaults to email-only when
  preference unknown.

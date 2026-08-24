# Scope discipline: feature extensions deferred to roadmap

We decided to reverse ADR-0009 (multi-channel SMS outbox) and ADR-0010
(dependents model) before implementation began, and to defer every
beyond-brief user-facing extension , waitlist, summary languages, voice input,
queue-position display , to [ROADMAP.md](../../ROADMAP.md). The submission
guidelines require "only what is strictly required" with "minimal, native"
dependencies, and the evaluation focus names specific mechanics (slot
conflicts, leave conflicts, notification reliability, LLM handling, schema,
API, docs) , none of which reward breadth. The freed scope budget is reinvested
in depth on the graded axes: a runnable concurrency-proof artifact, leave
preview + state-transition audit trail, dead-lettering and idempotent retries,
an async LLM generation lifecycle reusing the same reliability pattern as the
email queue, an admin queue-health view, and a hold countdown.

## Why record a reversal

The original decisions were correct product judgment but wrong for this
brief's grading contract. Recording both the decision and the reversal keeps
the review honest: the design thinking exists (ROADMAP sketches), the shipped
system matches the documents exactly, and no evaluator wonders why half-built
extras are absent.

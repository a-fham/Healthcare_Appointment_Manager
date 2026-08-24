# Monorepo with `server/` and `client/` packages

We decided on a single Git repository containing two independent packages:
`server/` (Express API, owns migrations and background jobs) and `client/`
(React + Vite SPA). The API serves the built client in production, so one
deployment unit covers the whole app.

## Why

The assignment is a small, single-team project where frontend and backend evolve
in lockstep (API contract changes force client changes the same day). A monorepo
gives atomic commits across both halves, one clone-and-run experience for the
reviewer (`npm install` twice, two commands), and matches the submission format
(one GitHub link). In production Express statically serves `client/dist`, so the
deployed artifact is still a single process.

## Considered options

- **Two repositories** , rejected: version drift between API and client, two
  submission links, harder local setup for the grader.
- **Single Next.js app** (frontend and API routes together) , rejected: see
  ADR-0004; the medication-reminder job needs a long-running process, which
  pushes us away from serverless anyway.

## Consequences

- Cross-package types are duplicated by design (client has its own thin API
  types). Acceptable at this size; a shared package would add tooling overhead
  out of proportion.

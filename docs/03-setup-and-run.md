# 03 , Setup & Run

## Prerequisites

- Node 22+
- PostgreSQL 16 reachable at `localhost:5432` (native service or Docker , either works)
- Google account only if you want real Calendar sync (optional; see below)

## 1. Database

```powershell
createdb -U postgres hcm_dev
createdb -U postgres hcm_test   # for the test suite
```

Migrations apply automatically on server boot; you can also run them by hand:

```powershell
cd server
npm run migrate          # applies server/migrations/*.sql in order to $DATABASE_URL
```

## 2. Environment

```powershell
cd server
Copy-Item .env.example .env    # then edit values
```

Every variable is documented in [`server/.env.example`](../server/.env.example).
Minimum viable config needs only `DATABASE_URL`, `JWT_SECRET`, `JOB_SECRET`.
Everything else degrades gracefully:

| Missing | Behaviour |
|---|---|
| `SMTP_HOST` | dev mail transport logs emails to the console instead of sending |
| `GOOGLE_REFRESH_TOKEN` | calendar rows retry then dead-letter `failed` (visible in admin health); nothing else changes |
| `LLM_PROVIDER != none` / no API key | deterministic fallback rubric writes the summaries |

## 3. Install, seed, run

```powershell
cd server
npm install
npm run seed             # admin + 3 doctors + sample patients (idempotent upserts)
npm run dev              # http://localhost:3000
```

Seeded logins (change in production): admin `admin@ashgrove.health /
admin-seed-pass-1`, doctors `meera.mehta@` / `arjun.rao@` / `fatima.sheikh@ashgrove.health`,
all `doctor-seed-pass-1..3`. Register patients through the UI.

The server serves the built SPA from `client/dist` when present:

```powershell
cd client
npm install
npm run build            # then just open http://localhost:3000
```

For UI development use the Vite dev server instead (`npm run dev` in `client/`)
, it proxies `/api` to `localhost:3000`.

## 4. Tests

```powershell
cd server
$env:DATABASE_URL='postgres://postgres:YOUR_PASSWORD@localhost:5432/hcm_test'
$env:AGENT_DB_URL='postgres://postgres:YOUR_PASSWORD@localhost:5432/hcm_test'
npx vitest run           # 268 tests across 22 files (see note below)
node scripts/concurrency-proof.mjs 16   # parallel-hold race demo
```

> The newer edge suites (`booking.matrix`, `booking.races`, `security.headers`,
> `platform.edges`, `api.edges`) read `AGENT_DB_URL` and create their own
> schema per run; the remaining legacy suites use `DATABASE_URL`. Pointing both
> at the same throwaway database is fine.

## 5. Background scheduler

Two equivalent triggers, same idempotent tick:

- **In-process cron** (default, `CRON_ENABLED=true`): every minute the server
  runs holds-sweeper → email worker → calendar worker → summary regenerator →
  medication reminders, then heartbeats `job_state`.
- **External tick**: `POST /api/jobs/tick` with header `x-job-secret: $JOB_SECRET`
  (for platforms without persistent processes). On Render free tier a cron-job
  service can ping this every minute.

## Google Calendar

1. [Google Cloud Console](https://console.cloud.google.com) → create project →
   enable **Google Calendar API**.
2. OAuth consent screen (External, test mode) → create **OAuth client ID → Web
   application**; authorized redirect URI `https://developers.google.com/oauthplayground`.
3. Put client id/secret in `.env` as `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
   Mint the refresh token with either route:
   - Helper script (recommended):
     `node src/scripts/google-oauth-setup.mjs` → open the printed consent URL →
     approve → run `node src/scripts/google-oauth-setup.mjs <CODE>` → paste the
     printed line into `.env` as `GOOGLE_REFRESH_TOKEN`.
   - Or via [OAuth Playground](https://developers.google.com/oauthplayground) ⚙ →
     tick *Use your own OAuth credentials* → scope
     `https://www.googleapis.com/auth/calendar.events` → authorize → exchange.
4. Set `GOOGLE_CALENDAR_ID` (the clinic calendar's ID or your own email; `primary`
   works for a personal calendar).

On confirmation the server inserts one event per audience (patient + doctor)
into that calendar with the appointment details; reschedule patches the events,
cancellation deletes them. Failures retry with backoff and dead-letter into the
admin health view exactly like email failures.

## Deployment sketch (Render free tier)

- Postgres: Render database; set `DATABASE_URL` to its connection string.
- Web service: root `server/`, build `npm ci`, start `npm start`;
  env from `.env.example` plus real secrets; `CRON_ENABLED=true`.
- Client: build locally or in a static site step; `client/dist` is served by the
  API process, so one web service hosts everything. Keep-alive ping
  `POST /api/jobs/tick` every minute via cron-job.org to dodge spin-down.

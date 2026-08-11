# TOWN Production Readiness Foundation V1 — Slice 1: Deployment Readiness

Contract for the runtime deployment surface of `town-api`. This document is
part of the codebase and is expected to be reviewed alongside code changes
that touch the health, migration, environment, or shutdown surfaces.

## 1. Scope

Slice 1 covers:

- Runtime build identity (`GET /health/build`).
- Enhanced readiness probe (`GET /health/ready`).
- Environment validation with staging/production fail-closed guards.
- Graceful shutdown on `SIGTERM` / `SIGINT`.
- Advisory-locked migration runner (`npm run db:migrate` locally via `tsx`;
  `npm run db:migrate:production` / `node dist/scripts/db-migrate.js` in the
  production image) and a non-mutating ledger verifier
  (`npm run db:migrate:verify`).
- Structured logging bindings and request-id validation.
- A container image (`Dockerfile`) and `.dockerignore`.
- A deployment smoke runner (`npm run smoke:deployment`).

## 2. Explicitly out of scope for Slice 1

Historical Slice 1 boundary (deployment-readiness foundation only):

- Any Railway CLI usage, deploy commands, DNS management, or platform-specific
  automation. No `railway login`, no `railway.toml`.
- Stripe live dashboard changes or real Stripe secrets.
- Frontend / mobile changes.
- New database migrations authored by that Slice 1 change set (the live
  repository journal has since grown; see current count below).
- `drizzle-kit push` or any live-schema mutation outside `drizzle-kit
migrate` (invoked via `npm run db:migrate`).

Current repository journal (authoritative for pre-flight checks): 22 entries
(`0000`–`0040`, 41 entries), derived from `drizzle/meta/_journal.json` /
`EXPECTED_MIGRATION_COUNT`.

## 3. Target environments

**Both environments are live** (verified against real Railway deployments and
live HTTP traffic, last confirmed 2026-08-10). PostgreSQL 18 in both.

| APP_ENV      | Public URL                          | Region                       | Notes                                                                                                  |
| ------------ | ----------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| `staging`    | `https://api-staging.towncivic.org` | `europe-west4` (Netherlands) | Stripe test mode. Staging public site talks to this API.                                               |
| `production` | `https://api.towncivic.org`         | `europe-west4` (Netherlands) | **Live.** Public site `towncivic.org` talks to this API. Stripe live mode required if billing enabled. |

Both environments now run in `europe-west4` (Netherlands), matching TOWN's
European community catalog (Italy, Germany, Romania, Austria, France,
Hungary, Spain). This was **not** always true: production originally ran in
`asia-southeast1` (Singapore), and the Postgres database, `town-api`, and
`town-public` were migrated to `europe-west4` on 2026-08-10, verified via
Railway deployment records and healthcheck latency (readiness probe —
which includes a live database round trip — dropped from previous
cross-region timings to ~27ms once the app services were co-located with
the database again). `town-api-migrations` and `town-api-seed-production`
(one-off release/seed jobs, not always-on) are still configured for
`asia-southeast1` as of this writing; low priority to move since they run
briefly and infrequently, but worth aligning for consistency next time
either is touched.

**Lesson learned during this migration, worth keeping in mind operationally:**
Railway config reads (e.g. `multiRegionConfig` on a service) can reflect a
**staged, undeployed** edit rather than what's actually running — the
dashboard's "Staged Changes" panel and an actual successful deployment
record are the only reliable ground truth. Don't trust a single config read
as proof of what's live; cross-check against the latest deployment's status
and, ideally, live behavior (e.g. request latency, health check timing).

`APP_ENV` should be authoritative for environment policy. Prefer gating
production-only rules on `APP_ENV === 'production'`; do not treat
`NODE_ENV=production` alone as a production deploy.

## 4. Runtime build identity

`GET /health/build` returns a minimal public identity:

```json
{
  "data": {
    "service": "town-api",
    "version": "<from package.json>",
    "commitSha": "<resolved effective commit SHA or null>",
    "environment": "development|test|staging|production"
  }
}
```

Contract:

- Never returns secrets, connection strings, hostnames, raw environment
  variables, or per-request data.
- Public body intentionally omits `nodeVersion`, `buildTimestamp`, and
  `expectedMigrationCount` to reduce external recon. Full identity remains
  available to authenticated platform operators.
- `commitSha` is the single resolved effective immutable deployment identity:
  - `RAILWAY_GIT_COMMIT_SHA` when present and valid (authoritative for Railway
    Git deployments; consumed from the runtime environment, not baked into the
    Docker image);
  - otherwise `APP_COMMIT_SHA` when present and valid (explicit fallback for
    CI, tests, local controlled environments, or non-Git deploy mechanisms);
  - otherwise `null` (intentional in development and test when neither is set).
- Both values, when present, must be full 40-character lowercase hexadecimal
  Git SHAs and must match exactly; mismatch fails closed at configuration load.
- This document does not claim that `RAILWAY_GIT_COMMIT_SHA` has already been
  activated or verified in live staging; removal of a manually maintained
  Railway `APP_COMMIT_SHA` is a separately approved operational action.
- Documented in OpenAPI under the `Health` tag.

## 5. Readiness (`/health/ready`)

The readiness probe returns:

```json
{
  "status": "ready" | "not_ready"
}
```

Component detail (`config` / `database` / `migrations`) is evaluated server-side
and written to structured logs plus the authenticated platform status API. It is
intentionally omitted from the public readiness body.

Ordering and bounded behaviour (evaluated server-side; not returned publicly):

1. If the process is shutting down (`app.isShuttingDown === true`), respond
   `503` immediately without further probing.
2. Otherwise, run the PostgreSQL connectivity check bounded by
   `READINESS_TIMEOUT_MS`. On timeout/error, respond `503`.
3. Otherwise, run the migration ledger check bounded by the same timeout.
   Respond `200` only when the applied ordered `(hash, created_at)` sequence
   exactly matches the repository journal+SQL expected sequence; otherwise
   `503`.
4. `config` is treated as `ok` whenever the process has successfully loaded
   configuration at boot (a fail-closed validation happens in
   `src/config/env.ts`). Any misconfiguration prevents the process from
   starting.

Never exposes: migration names, SQL, PostgreSQL error text, host, port,
credentials, or Stripe state. The route never calls Stripe.

## 6. Environment fail-closed guards

`src/config/env.ts` rejects boot when the following invariants are violated:

- `APP_ENV=production` or `NODE_ENV=production`:
  - At least one of `RAILWAY_GIT_COMMIT_SHA` or `APP_COMMIT_SHA` must be
    present as a full 40-character lowercase hexadecimal Git SHA. If both are
    set, they must match exactly.
  - `DATABASE_URL` must not contain `localhost`, `127.0.0.1`, or `town:town@`.
  - `WEBAUTHN_ALLOWED_ORIGINS` must not include `localhost` / `127.0.0.1`.
  - `WEBAUTHN_RP_ID` must not be `localhost`.
  - If `STRIPE_BILLING_ENABLED=true`, `STRIPE_EXPECTED_LIVEMODE` must be
    `true`.
  - No environment value may equal a known CI hash-key placeholder (see
    `KNOWN_CI_HASH_KEY_PLACEHOLDERS` in `src/config/env.ts`).
- `APP_ENV=staging`:
  - At least one of `RAILWAY_GIT_COMMIT_SHA` or `APP_COMMIT_SHA` must be
    present (same SHA format and match rules as production).
  - If `STRIPE_BILLING_ENABLED=true`, `STRIPE_EXPECTED_LIVEMODE` must be
    `false` and `STRIPE_SECRET_KEY` must not begin with `sk_live_`.

Email verification may be enabled in production only with
`EMAIL_VERIFICATION_DELIVERY_MODE=resend` (plus Resend credentials).
`ACCOUNT_RECOVERY_ENABLED` may be true in production only with
`ACCOUNT_RECOVERY_DELIVERY_MODE=resend` (reuses
`EMAIL_VERIFICATION_RESEND_API_KEY` and `EMAIL_VERIFICATION_FROM_ADDRESS`).
Test/development recovery delivery modes are rejected when
`NODE_ENV=production`.

## 7. Graceful shutdown

`installGracefulShutdown(app, { timeoutMs, onExit? })` in
`src/ops/graceful-shutdown.ts`:

- Registered once per process from `src/server.ts`.
- Handles `SIGTERM` and `SIGINT` idempotently. Duplicate registration is a
  no-op (returns the existing handle).
- On signal:
  1. Sets `app.isShuttingDown = true` so `/health/ready` fails fast.
  2. Awaits `app.close()`, which fires Fastify `onClose` hooks including the
     database pool close registered by `src/db/plugin.ts`.
  3. Force-exits with code `1` if teardown exceeds `timeoutMs`
     (`GRACEFUL_SHUTDOWN_TIMEOUT_MS`, default 10000).
  4. Exits with code `0` on clean teardown.
- Logs only bounded fields (`signal`, `event`, `timeoutMs`). Never logs env,
  headers, or credentials.

## 8. Migration runner and verifier

`npm run db:migrate` (`scripts/db-migrate.ts` → `src/db/run-migrations.ts`):

- Local / CI entrypoint via `tsx`. Same safety controls as production.
- Acquires a PostgreSQL advisory lock keyed by
  `hashtext('town-api-migrate')` before invoking drizzle's migrator, and
  releases it in `finally`.
- Exits non-zero on failure. The success line contains no secrets.
- Concurrent invocations serialize on the advisory lock, so only one migrate
  process at a time can advance the ledger.

`npm run db:migrate:production` (`node dist/scripts/db-migrate.js`):

- Production / one-off migration service entrypoint. Requires only Node and
  production dependencies (no `tsx`, no TypeScript sources).
- Compiles from `src/scripts/db-migrate.ts` into `dist/scripts/db-migrate.js`
  and reuses `src/db/run-migrations.ts` (no duplicated migrate logic).
- Image already ships `dist/`, `drizzle/`, and `package.json`. Migrations are
  never invoked by the persistent API `CMD`.

`npm run db:migrate:verify` (`scripts/db-migrate-verify.ts`):

- Non-mutating. Reads `drizzle.__drizzle_migrations` (`id`, `hash`,
  `created_at`) ordered by `id` and compares to the repository-expected
  sequence derived from `drizzle/meta/_journal.json` plus SHA-256 hashes of
  each `${tag}.sql` file (same algorithm as `drizzle-orm/migrator`).
- Detects missing, extra, hash mismatch (including same-count/different-
  history), timestamp mismatch, order permutation, and malformed rows.
- Exit code `0` on match, `1` on mismatch or incomplete.
- Shares logic with `/health/ready` via `src/db/migration-ledger.ts`.

### Runtime CORS

`@fastify/cors@11.3.0` is registered in `buildApp` with an exact allowlist
from `WEBAUTHN_ALLOWED_ORIGINS` (`src/ops/cors-origins.ts`,
`src/plugins/cors.ts`):

- No wildcard origins.
- Rejects unauthorized, `null`, and malformed Origins (no ACAO reflection).
- Accepts only exact configured origins; credentials enabled for cookie
  sessions.
- Methods: GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS.
- Headers: Content-Type, Authorization, X-Request-Id, X-TOWN-Control-Key,
  Stripe-Signature.
- Preflight `maxAge`: 600 seconds.
- Requests without an `Origin` header remain functional (native/server).
- CORS is not authentication or authorization.

`buildApp()` and `src/server.ts` intentionally do NOT run migrations at
startup. Migration is a deploy-time step.

## 9. Logging and request-id

- Base logger bindings: `service=town-api`, `environment=<APP_ENV>`,
  `version`, `commitSha`.
- Incoming `x-request-id` is accepted only when it matches
  `/^[A-Za-z0-9._:-]{1,128}$/`. Otherwise the runtime generates a fresh
  `req_<uuid>`. The accepted or generated id is always echoed back on the
  response as `x-request-id`.
- pino `redact` covers `authorization`, `cookie`, `x-town-control-key`,
  `stripe-signature`, `DATABASE_URL`, and all Stripe / session / hash key
  environment names.

## 10. Container image

`Dockerfile` is a four-stage build on `node:24-bookworm-slim`. Production
dependencies only, non-root user (`town`, uid 1001), `EXPOSE 3000`,
`CMD ["node", "dist/server.js"]`. Migrations are NOT invoked in `CMD`. The
image is platform-agnostic; the deployment platform must inject the
environment variables listed in `.env.example` and run the one-off
migration command (`npm run db:migrate:production` or
`node dist/scripts/db-migrate.js`) before rolling the new API container.

## 11. Smoke runner

`npm run smoke:deployment -- --base-url URL --environment ENV ...` runs a
bounded set of read-only checks:

- Transport must be HTTPS unless the base URL is `http://127.0.0.1`
  (loopback for local exercises).
- `/health/live` returns `{"status":"ok"}`.
- `/health/ready` returns `{ "status": "ready" }` (status-only public body).
- `/health/build` matches `--environment`; when `--expect-commit` is given,
  `commitSha` must match.
- An unauthorized route (`GET /v1/account/membership`) returns `401` when
  `--auth-enabled true` (default), or `404` when `--auth-enabled false`
  (passkey authentication flag off).
- CORS: no-Origin remains valid; literal `null` Origin is rejected;
  unauthorized Origin is rejected; configured authorized Origin is accepted
  with credentials; authorized preflight returns methods and bounded max-age
  (`--authorized-origin` / `--unauthorized-origin`).
- `POST /v1/billing/stripe/webhook` with an invalid `Stripe-Signature` returns
  `400` when billing is enabled, or `404` when `STRIPE_BILLING_ENABLED` is off.
  A `2xx` or `5xx` response fails the check.
- No response body includes a known secret sentinel (`sk_live_`, `whsec_`,
  `sk_test_`, `BEGIN PRIVATE KEY`, etc.); if it does, the check fails.

Exit code is non-zero when any check fails. The last stdout line is a
machine-readable JSON summary.

## 12. Deployment order, rollback, and backups

**Deploys are triggered by CI on merge to `main`**, via the `deploy-staging`
and `deploy-production` jobs in `.github/workflows/ci.yml`. They run
`railway up --service <name>` in attached mode (not `--ci`), which blocks
until the deployment reaches a terminal status and exits non-zero on
failure — a real CI gate, not a fire-and-forget trigger. `deploy-production`
`needs: deploy-staging`, so production only deploys after staging succeeds.

This deliberately must not rely on Railway's own "auto-deploy from GitHub"
feature. On 2026-08-10, the `watchPatterns` filters were cleared from all four
Railway services (`town-api`, `town-api-staging`, `town-public`,
`town-public-staging`) after direct deployment evidence showed that the
filters also caused the CI-triggered `railway up` deployments to be skipped.
The filters are therefore **not** a current safety control.

Clearing `watchPatterns` re-enabled the possibility of Railway native
GitHub auto-deploys, which can race with the CI-gated pipeline and create
redundant deployments. The intended configuration is to disable Railway
native automatic deployments for all four services in the dashboard, leaving
the GitHub Actions `railway up` jobs as the only deployment trigger. The
native auto-deploy toggle is not exposed by the available read-only tooling;
until its disabled state is verified directly in the dashboard, treat this as
an open human verification step rather than a completed control.

**Requires `RAILWAY_TOKEN` configured as a GitHub Environment secret** (via
repo Settings → Environments → `staging` / `production`) in both
`michaeltofan/town-api` and `michaeltofan/town-public`, using a Railway
[project token](https://docs.railway.com/integrations/api#project-token)
scoped to that environment (one token per environment, reusable across both
repos since project tokens are environment-scoped, not service-scoped). If
this secret is missing, the deploy jobs fail loudly (not silently) and the
manual fallback still works: trigger "Deploy Latest Commit" from the Railway
dashboard, then confirm `GET /health/build` (`commitSha`) matches the merge
commit before telling anyone a change has shipped. Optionally, add required
reviewers to the `production` GitHub Environment for a manual approval gate
before production deploys — not configured by default.

Order for staging or production deployment:

1. Merge to `main`.
2. Build the container image (do not bake a commit SHA into the image). For
   Railway Git deployments, `RAILWAY_GIT_COMMIT_SHA` is injected at runtime.
   For CI or non-Git deploy mechanisms, set `APP_COMMIT_SHA` to the merge
   commit SHA explicitly. If both are present they must match.
3. CI triggers the deployment (`deploy-staging` / `deploy-production` job)
   and blocks on its real terminal status — see above.
4. Run `npm run db:migrate:production` (or `node dist/scripts/db-migrate.js`)
   against the target database from a controlled one-off release step. Fail
   deploy if this fails. Do not run migrations from the persistent API
   service startup.
5. Run `npm run db:migrate:verify` when a full checkout with `tsx` is
   available (CI / operator workstation). Fail deploy on mismatch.
6. Roll the new container. `/health/live` must return `200` before the
   platform routes traffic; `/health/ready` must return `200` before the
   platform marks the release healthy.
7. Run `npm run smoke:deployment -- --base-url … --environment staging` (or
   `production`) with `--expect-commit <sha>`.

Rollback:

- Revert the platform to the previous container image.
- Do NOT roll back migrations automatically. Slice 1 ships no destructive
  down migrations. If a schema rollback is required, it must be authored as
  a new forward migration in a subsequent slice.

Backups:

- PostgreSQL 18 point-in-time recovery is provided by the platform (Railway).
  **Confirmed enabled on production as of 2026-08-10** — verified directly
  via Railway service config: `WAL_ARCHIVE_BUCKET`, `WAL_ARCHIVE_ENDPOINT`,
  `WAL_ARCHIVE_KEY`, `WAL_ARCHIVE_PATH`, `WAL_ARCHIVE_REGION`,
  `WAL_ARCHIVE_SECRET` are present on the production Postgres service,
  referencing a real Railway Bucket resource. Before this date, PITR was
  **not actually enabled** despite `DATABASE_BACKUP_PITR_ENABLED=true`
  existing as an app-level env var — that variable only reflects an
  operator's claim, it does not turn PITR on or verify it's on. Don't trust
  it as proof; check the Postgres service's own config for `WAL_ARCHIVE_*`
  variables, or the Backups tab in the dashboard.
  Per Railway's PITR docs, the restore window starts from the first
  post-enable base backup, not retroactively — so there's no usable restore
  point immediately after enabling; a real restore drill needs to wait for
  the first base backup to complete.
- The API does not run dump jobs or workers. Operator console Monitor exposes
  automated PITR configuration via `DATABASE_BACKUP_*` env vars and records
  ops_admin verifications at `GET/POST /v1/platform/backup`.
- Restore is attestation-only: operators record out-of-band Railway restore
  drills at `GET/POST /v1/platform/restore` (`/attest`). The API never executes
  `pg_restore` or clones against staging/production. Keep the latest passed
  drill fresher than `DATABASE_RESTORE_DRILL_MAX_AGE_DAYS` (default 90). As
  of this writing no drill has been attested yet — enabling PITR is a
  prerequisite, not the drill itself.
- Configure staging/production with:
  `DATABASE_BACKUP_PROVIDER=railway_postgres_pitr`,
  `DATABASE_BACKUP_PITR_ENABLED=true`,
  `DATABASE_BACKUP_RETENTION_DAYS=<platform retention>`,
  and keep operator verification fresher than
  `DATABASE_BACKUP_VERIFY_MAX_AGE_DAYS` (default 30).

Stripe webhook path (implemented; dashboard configuration remains a human
operator action and is outside this documentation cleanup):

- Staging:
  `https://api-staging.towncivic.org/v1/billing/stripe/webhook`
- Production:
  `https://api.towncivic.org/v1/billing/stripe/webhook`

Stripe is the sole membership payment provider for the current web launch.
Google Play, Flutter, Apple In-App Purchase, and native app-store distribution
are outside the current critical path.

## 13. Reference

| Item                     | Location                                     |
| ------------------------ | -------------------------------------------- |
| Build identity assembler | `src/ops/build-identity.ts`                  |
| Readiness route          | `src/routes/health.ts`                       |
| Migration ledger         | `src/db/migration-ledger.ts`                 |
| Graceful shutdown        | `src/ops/graceful-shutdown.ts`               |
| Request-id validation    | `src/ops/request-id.ts`                      |
| Environment validation   | `src/config/env.ts`                          |
| Migration runner         | `scripts/db-migrate.ts`                      |
| Migration verifier       | `scripts/db-migrate-verify.ts`               |
| Smoke runner (library)   | `src/ops/smoke-runner.ts`                    |
| Smoke runner (CLI)       | `scripts/smoke-deployment.ts`                |
| Container                | `Dockerfile`, `.dockerignore`                |
| Deployment checklist     | `docs/operations/DEPLOYMENT_CHECKLIST_V1.md` |

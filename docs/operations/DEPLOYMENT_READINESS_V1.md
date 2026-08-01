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
(`0000`–`0021`), derived from `drizzle/meta/_journal.json` /
`EXPECTED_MIGRATION_COUNT`.

## 3. Target environments

The API is deployed to the Amsterdam region on PostgreSQL 18 in two runtime
environments:

| APP_ENV      | Public URL                          | Notes                                         |
| ------------ | ----------------------------------- | --------------------------------------------- |
| `staging`    | `https://api-staging.towncivic.org` | Stripe test mode; live-mode expectations off. |
| `production` | `https://api.towncivic.org`         | Stripe live mode required if billing enabled. |

`APP_ENV` is authoritative. `NODE_ENV` is retained for framework defaults
(e.g. Fastify logger presets) but the runtime and fail-closed environment
validator prefer `APP_ENV` when both are set.

## 4. Runtime build identity

`GET /health/build` returns exactly:

```json
{
  "data": {
    "service": "town-api",
    "version": "<from package.json>",
    "commitSha": "<resolved effective commit SHA or null>",
    "environment": "development|test|staging|production",
    "nodeVersion": "<process.version>",
    "buildTimestamp": "<APP_BUILD_TIMESTAMP or null>",
    "expectedMigrationCount": <integer>
  }
}
```

Contract:

- Never returns secrets, connection strings, hostnames, raw environment
  variables, or per-request data.
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
- `expectedMigrationCount` is derived from the shipped
  `drizzle/meta/_journal.json` at module load; it is a stable, non-secret
  build-time constant.
- Documented in OpenAPI under the `Health` tag.

## 5. Readiness (`/health/ready`)

The readiness probe returns:

```json
{
  "status": "ready" | "not_ready",
  "checks": {
    "config": "ok" | "fail",
    "database": "ok" | "fail" | "timeout",
    "migrations": "ok" | "fail" | "unknown"
  }
}
```

Ordering and bounded behaviour:

1. If the process is shutting down (`app.isShuttingDown === true`), respond
   `503` immediately. `database` is set to `fail` and `migrations` to
   `unknown` to signal that no further probing was attempted.
2. Otherwise, run the PostgreSQL connectivity check bounded by
   `READINESS_TIMEOUT_MS`. On timeout, `database: timeout`. On any other
   error, `database: fail`. On success, `database: ok`.
3. If `database` is not `ok`, respond `503` with `migrations: unknown`.
4. Otherwise, run the migration ledger check bounded by the same timeout.
   `ok` when the applied ordered `(hash, created_at)` sequence exactly matches
   the repository journal+SQL expected sequence. `fail` on missing, extra,
   hash mismatch, timestamp mismatch, order mismatch, or malformed ledger
   rows. `unknown` when the `drizzle.__drizzle_migrations` table does not
   yet exist. Same-count/different-history is detected via hash comparison.
5. `config` is `ok` whenever the process has successfully loaded
   configuration at boot (a fail-closed validation happens in
   `src/config/env.ts`). Any misconfiguration prevents the process from
   starting, so a running server always reports `config: ok`.

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
- `/health/ready` returns `status:ready` with `checks` object.
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

Order for staging or production deployment:

1. Merge to `main`.
2. Build the container image (do not bake a commit SHA into the image). For
   Railway Git deployments, `RAILWAY_GIT_COMMIT_SHA` is injected at runtime.
   For CI or non-Git deploy mechanisms, set `APP_COMMIT_SHA` to the merge
   commit SHA explicitly. If both are present they must match.
3. Publish to the platform (Amsterdam region).
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
  Confirm the retention window with the platform admin before any invasive
  change.
- The API does not run dump jobs or workers. Operator console Monitor exposes
  automated PITR configuration via `DATABASE_BACKUP_*` env vars and records
  ops_admin verifications at `GET/POST /v1/platform/backup`.
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

# TOWN API — Deployment Readiness V1 Checklist

Companion to `DEPLOYMENT_READINESS_V1.md`. Use for every staging or
production deployment.

## Pre-flight (once per branch)

- [ ] Branch merged to `main`; CI green.
- [ ] `npm run db:check` shows no drift and journal shows exactly 22
      entries (`0000`–`0040`, 41 entries).
- [ ] `npm run openapi:check` passes (docs match source).
- [ ] All contract checks pass (`identity`, `auth`, `membership`, `billing`).
- [ ] `npm run build && npm run check` succeed locally.
- [ ] `npm audit --omit=dev` clean.

## Environment (per target)

- [ ] `APP_ENV` set to `staging` or `production`.
- [ ] Immutable deployment identity present: Railway Git deployments rely on
      runtime `RAILWAY_GIT_COMMIT_SHA`; CI / non-Git mechanisms set
      `APP_COMMIT_SHA` to the exact merge commit SHA. If both are set, they
      must match. Removing a manually maintained Railway `APP_COMMIT_SHA` is a
      separately approved operational action.
- [ ] `APP_BUILD_TIMESTAMP` set (optional but recommended).
- [ ] `DATABASE_URL` points at the target database (no local placeholders).
- [ ] `READINESS_TIMEOUT_MS` and `GRACEFUL_SHUTDOWN_TIMEOUT_MS` reviewed.
- [ ] Stripe environment matches `APP_ENV`: - Staging: `STRIPE_EXPECTED_LIVEMODE=false`, no `sk_live_` keys. - Production: `STRIPE_EXPECTED_LIVEMODE=true`.
- [ ] `WEBAUTHN_*` values do not include `localhost`.
- [ ] No CI hash-key placeholders present.

## Release

- [ ] Container image built from Node.js 24 with production dependencies
      only.
- [ ] **CI-triggered deployment succeeded** (`deploy-staging` / `deploy-production`
      job in `ci.yml`, blocking on real terminal status via `railway up`).
      If `RAILWAY_TOKEN` isn't configured yet, fall back to manually
      triggering "Deploy Latest Commit" in the Railway dashboard and confirm
      it resolved to the merge commit, not a stale snapshot.
- [ ] Image published (`asia-southeast1` for production,
      `europe-west4` for staging — see `DEPLOYMENT_READINESS_V1.md` §3 for
      the known region mismatch).
- [ ] `npm run db:migrate:production` (or `node dist/scripts/db-migrate.js`)
      run from a controlled one-off release step (advisory lock acquired).
      Not from persistent API startup.
- [ ] `npm run db:migrate:verify` returns `status: ok`, `detail: ok`, and
      applied/expected counts match the journal (ordered hash+timestamp)
      when run from a checkout that has `tsx` / dev tooling.
- [ ] New container rolled; `/health/live` returns `200`.
- [ ] `/health/ready` returns `200` with `{ "status": "ready" }`.
- [ ] `/health/build` returns the expected `environment` and `commitSha`.

## Smoke

- [ ] `npm run smoke:deployment -- --base-url https://api-staging.towncivic.org \
 --environment staging --expect-commit <sha> --auth-enabled false` passes.
- [ ] `npm run smoke:deployment -- --base-url https://api.towncivic.org \
 --environment production --expect-commit <sha>` passes. Production
      (`api.towncivic.org`) has been live since 2026-08. Do not skip this step.
- [ ] Unauthorized routes still return `401` when auth is enabled, or `404`
      when `--auth-enabled false`.
- [ ] Invalid Stripe webhook signatures on `POST /v1/billing/stripe/webhook`
      still return `400` (once billing is live per environment), or `404` when
      billing is disabled.

## Observability

- [ ] Logs show `service=town-api`, `environment=<APP_ENV>`, `version`,
      `commitSha` on every request line.
- [ ] `x-request-id` echoed on responses and correlates with log records.

## Rollback

- [ ] Staging: run the `Rollback staging` GitHub Actions workflow
      (`workflow_dispatch`, no input needed for "previous good deployment").
      It waits for `/health/ready` and runs `smoke:deployment` before
      finishing.
- [ ] Production: no one-click automation; roll back from the Railway
      dashboard or the `deploymentRollback` API mutation, then run
      `smoke:deployment` against `https://api.towncivic.org` manually.
- [ ] Rollback restores the previous container image and its variables, not
      the database.
- [ ] Do NOT attempt schema rollback. Author a new forward migration if a
      schema change must be reversed.

## Post-flight

- [ ] Confirm PostgreSQL 18 backup / PITR status with the platform admin and
      record verification in `/platform/` Monitor → Backup (`POST /v1/platform/backup/verify`).
- [ ] Confirm a restore drill was performed: run the "Production restore
      drill" GitHub Actions workflow (`.github/workflows/restore-drill.yml`,
      see `docs/operations/RESTORE_DRILL_RUNBOOK.md`), which restores
      production's PITR archive into an isolated, disposable sibling
      service, validates it, and deletes it -- production is never
      restored over. Then record attestation in `/platform/` Monitor →
      Restore (`POST /v1/platform/restore/attest`) using the workflow's
      printed RPO/RTO. Do not restore into staging/prod from the console.
- [ ] For support/investigation handoffs, use `/platform/` Investigate →
      Download pack (`GET /v1/platform/accounts/:accountId/export`). Packs
      omit Stripe provider IDs and secrets.
- [ ] File any follow-ups from the smoke run.

## Exclusions

- [ ] No Railway CLI, no DNS changes, no Stripe dashboard changes performed
      as part of Slice 1 automation.
- [ ] No frontend / mobile changes.
- [ ] No new migrations added.

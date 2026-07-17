# TOWN API — Deployment Readiness V1 Checklist

Companion to `DEPLOYMENT_READINESS_V1.md`. Use for every staging or
production deployment.

## Pre-flight (once per branch)

- [ ] Branch merged to `main`; CI green.
- [ ] `npm run db:check` shows no drift and journal shows exactly 12
      entries (`0000`–`0011`).
- [ ] `npm run openapi:check` passes (docs match source).
- [ ] All contract checks pass (`identity`, `auth`, `membership`, `billing`).
- [ ] `npm run build && npm run check` succeed locally.
- [ ] `npm audit --omit=dev` clean.

## Environment (per target)

- [ ] `APP_ENV` set to `staging` or `production`.
- [ ] `APP_COMMIT_SHA` set to the exact merge commit SHA.
- [ ] `APP_BUILD_TIMESTAMP` set (optional but recommended).
- [ ] `DATABASE_URL` points at the target database (no local placeholders).
- [ ] `READINESS_TIMEOUT_MS` and `GRACEFUL_SHUTDOWN_TIMEOUT_MS` reviewed.
- [ ] Stripe environment matches `APP_ENV`: - Staging: `STRIPE_EXPECTED_LIVEMODE=false`, no `sk_live_` keys. - Production: `STRIPE_EXPECTED_LIVEMODE=true`.
- [ ] `WEBAUTHN_*` values do not include `localhost`.
- [ ] No CI hash-key placeholders present.

## Release

- [ ] Container image built from Node.js 24 with production dependencies
      only.
- [ ] Image published (Amsterdam region).
- [ ] `npm run db:migrate` run from a controlled release step (advisory
      lock acquired).
- [ ] `npm run db:migrate:verify` returns `status: ok` and `applied`
      equals the expected count.
- [ ] New container rolled; `/health/live` returns `200`.
- [ ] `/health/ready` returns `200` with all three components `ok`.
- [ ] `/health/build` returns the expected `environment` and `commitSha`.

## Smoke

- [ ] `npm run smoke:deployment -- --base-url https://api-staging.towncivic.org \
 --environment staging --expect-commit <sha>` passes.
- [ ] `npm run smoke:deployment -- --base-url https://api.towncivic.org \
 --environment production --expect-commit <sha>` passes.
- [ ] Unauthorized routes still return `401`.
- [ ] Invalid Stripe webhook signatures still return `400` (once billing is
      live per environment).

## Observability

- [ ] Logs show `service=town-api`, `environment=<APP_ENV>`, `version`,
      `commitSha` on every request line.
- [ ] `x-request-id` echoed on responses and correlates with log records.

## Rollback

- [ ] Roll back to the previous container image.
- [ ] Do NOT attempt schema rollback. Author a new forward migration if a
      schema change must be reversed.

## Post-flight

- [ ] Confirm PostgreSQL 18 backup / PITR status with the platform admin.
- [ ] File any follow-ups from the smoke run.

## Exclusions

- [ ] No Railway CLI, no DNS changes, no Stripe dashboard changes performed
      as part of Slice 1 automation.
- [ ] No frontend / mobile changes.
- [ ] No new migrations added.

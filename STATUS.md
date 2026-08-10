# TOWN operational status

Single source of truth for what's actually live vs. in-flight vs. blocked on
a human step. Update this file instead of trusting a chat summary — if it's
not merged to `main` here, it isn't real.

Last updated: 2026-08-10, by Claude (session finishing the production
readiness follow-through).

## Live in production right now

- `api.towncivic.org` (town-api) and `towncivic.org` (town-public) — both up,
  in Railway project `town-public`, environment `production`, region
  `europe-west4`.
- PostgreSQL 18 with point-in-time recovery genuinely enabled (`WAL_ARCHIVE_*`
  variables confirmed present on the production Postgres service, referencing
  a real Railway bucket — verified directly, not taken on faith from an
  app-level env var).
- Deployment docs (`docs/operations/DEPLOYMENT_READINESS_V1.md`,
  `DEPLOYMENT_CHECKLIST_V1.md`) reflect reality: production live, region
  documented, production smoke test un-skipped. Merged via #113.

## Shipped this session, verified with real evidence

- **Staging capacity test actually run** (not just written): 10,591 requests,
  0% failures, all latency thresholds passed, `/health/ready` stayed healthy
  under ~100 concurrent readers for the full 3m30s run. See
  `loadtest/README.md` → Results. PR #115.
- **Automated health alerting**: `.github/workflows/health-alert.yml` polls
  `/health/live` + `/health/ready` on both environments every 15 minutes and
  opens/closes a GitHub issue (label `automated-health-alert`) instead of
  relying on someone remembering to look at a dashboard. PR #114.

## In place but not yet functional — needs one human step

- **CI-driven auto-deploy** (`deploy-staging` / `deploy-production` jobs in
  `ci.yml`, both `town-api` and `town-public`): the code is on `main`, but it
  needs a `RAILWAY_TOKEN` GitHub Environment secret (Settings → Environments
  → `staging` / `production`, both repos) using a Railway project token. No
  tool available to this session can mint that token — Railway doesn't expose
  token creation over the API, only the dashboard (Account/Project Settings →
  Tokens). Until it's added, these jobs fail loudly on every merge to `main`
  (by design — not a silent no-op) and the manual "Deploy Latest Commit" in
  the Railway dashboard remains the fallback.
  - **Action needed from you:** create the token, add it as `RAILWAY_TOKEN`
    in both environments in both repos.

## Not done — explicitly, not silently

- **Backup/restore drill**: PITR is enabled, but no restore has actually been
  executed and no attestation has been recorded at `/v1/platform/restore/attest`.
  Two reasons this session couldn't finish it:
  1. Railway's "restore to a point in time" action is dashboard-only
     (Backups tab → pick timestamp → "Restore to this moment") — there is no
     API/CLI path exposed to this session, and no local Railway CLI in this
     sandbox either.
  2. Recording the attestation requires an authenticated `ops_admin+`
     operator session against the platform console — the API explicitly
     documents `/v1/platform/restore` as "never executes database restore,"
     and the attest endpoint needs `manage_restore` permission, which this
     session has no credential for by design.
  - **Action needed from you:** either do the restore yourself (Railway
    dashboard, ~10 minutes once a base backup exists) and record the
    attestation from the platform console, or walk through it together in a
    session where you're logged in as an ops_admin operator.

## Known pre-existing gap, not part of this pass

- `town-api-migrations` and `town-api-seed-production` (one-off release jobs)
  are still configured for `asia-southeast1` while everything else moved to
  `europe-west4` on 2026-08-10. Low priority — they run briefly and
  infrequently — but worth fixing next time either is touched.

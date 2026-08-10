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

## CI-driven auto-deploy — now working, verified end-to-end

`RAILWAY_TOKEN` is configured in both `staging` and `production` GitHub
Environments, both repos. Two real bugs found and fixed while verifying this
(not assumed — actually triggered deploys and read the logs):

1. **Token was empty on first attempt** (`Invalid RAILWAY_TOKEN` in the CI
   log) — regenerated and re-added, confirmed working.
2. **Every service's `watchPatterns` build filter
   (`/.railway/manual-release-only/**`) was silently SKIPPING every deploy**,
   including CLI-triggered ones — contradicting the assumption in PR #113
   that `railway up`sidesteps it. Cleared`watchPatterns`on all 4 services
   (town-api, town-api-staging, town-public, town-public-staging) with your
   explicit go-ahead. Confirmed via Railway deployment records: builds now
   actually run instead of showing`SKIPPED`.

**Verified live right now** (checked deploy logs directly, not just CI
green): `api.towncivic.org` and `api-staging.towncivic.org` are both running
commit `095bd7e3` with `/health/ready` returning `200`. `town-public`'s
full CI-gated pipeline (staging → production) ran end-to-end successfully.

**Decided, one manual click still needed:** clearing `watchPatterns` also
re-enabled Railway's own _native_ GitHub auto-deploy (separate from our
CI-gated `railway up` jobs), which fires immediately on push and does not
wait for our `ci.yml` quality job — observed one redundant deploy get
discarded automatically by Railway's zero-downtime rollout when it failed
its healthcheck (no outage, just wasted work). Decision: keep only the
CI-gated pipeline.

- **Action needed from you:** for each of the 4 services (town-api,
  town-api-staging, town-public, town-public-staging) — Service → Settings →
  Source (GitHub) → click **Disable** on automatic deployments. Not exposed
  via any tool available to this session; it's a one-click dashboard toggle.
  Once disabled, the only thing that deploys is the CI-gated `railway up`
  job after `ci.yml`/`e2e.yml`'s quality job passes.

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

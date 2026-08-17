# TOWN operational status

Single source of truth for what's actually live vs. in-flight vs. blocked on
a human step. Update this file instead of trusting a chat summary — if it's
not merged to `main` here, it isn't real.

Last updated: 2026-08-17, by Claude (Pilot Madrid session — restore drill
attestation and known-errors sections refreshed; rest of the file
unchanged since 2026-08-10 and not re-verified this pass).

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

- **Action needed from you:** verify in the Railway dashboard that automatic
  deployments are **Disabled** for each of the 4 services (`town-api`,
  `town-api-staging`, `town-public`, `town-public-staging`) under
  Service → Settings → Source (GitHub). The current toggle state is not
  exposed by the available read-only tooling, so this remains an explicit
  human verification rather than a completed claim. Once all four toggles
  are disabled, only the CI-gated `railway up` jobs deploy after the
  `ci.yml`/`e2e.yml` quality jobs pass.

## Restore drill — done, 2026-08-17

- Automated drill (`.github/workflows/restore-drill.yml`, "Production
  restore drill") ran successfully 2026-08-13 after 7 earlier failures
  (`docs/operations/RESTORE_DRILL_RUNBOOK.md` has the full mechanism).
- Attestation recorded for real by Mihail, from the platform console
  (`https://towncivic.org/platform/` → Status → Restore → "Record restore
  drill"), 2026-08-17T07:13:30.457Z. Confirmed directly in
  `GET /v1/platform/restore`: `outcome: passed`,
  `method: railway_pitr_point_in_time`. This is not inferred from CI —
  it's the actual attestation record.

## Known technical errors — production, 2026-08-06 to 2026-08-08

- Console's recent-errors panel (`GET /v1/platform/errors`) shows recurring
  500s on `GET /v1/signals/:signalId/civic-process` and
  `GET /v1/account/activity` across multiple builds, 6-8 aug. Zero
  recurrences since (checked 2026-08-17, 9+ days clean).
- Probable root cause identified in code, not confirmed: the civic-process
  backfill guard at `src/routes/civic-process.ts:200-202` throws a plain
  `Error` (mapped to 500) if a published signal's civic-process row still
  doesn't match its community after an automatic backfill attempt — the
  comment there points at a re-seed via `ON CONFLICT DO UPDATE` not
  re-firing the row's creation trigger.
- Could not get further confirmation: Railway's log retention had already
  expired for that window by the time this was investigated, and the
  error-handler (`src/plugins/error-handler.ts`) deliberately never
  persists the raw error message/stack to the technical-errors table —
  only a fixed safe string — so even the platform API itself can't reveal
  more than what's already summarized here.
- Mihail reviewed this and explicitly decided to proceed (2026-08-17) —
  not treated as silently resolved.

## Known pre-existing gap, not part of this pass

- `town-api-migrations` and `town-api-seed-production` (one-off release jobs)
  are still configured for `asia-southeast1` while everything else moved to
  `europe-west4` on 2026-08-10. Low priority — they run briefly and
  infrequently — but worth fixing next time either is touched.

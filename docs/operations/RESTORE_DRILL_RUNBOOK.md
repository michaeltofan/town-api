# Production restore drill runbook

Etapa 3 of the TOWN deployment plan: prove that production's Postgres
backups are actually restorable, on a schedule, without ever touching
production itself.

## What this does

Railway's Point-in-Time Recovery (PITR) restore always creates a **new,
separate sibling Postgres service** and replays the source's archived WAL
into it. The source keeps serving traffic the entire time and is never
modified. This drill uses that guarantee to restore the most recent healthy
point from production's PITR archive into a disposable, isolated service,
validates the data there using a second disposable service, and deletes
both.

Non-negotiable properties of every run:

- The production Postgres service (`Postgres-9UWs`) is the read-only WAL
  source and is never written to, restored over, or restarted.
- The restored sibling service never receives application traffic: no app
  service is ever pointed at it, and it gets no public domain. Neither does
  the validator service that reads from it.
- No migrations, seeds, or writes of any kind run against the restored
  sibling. `src/platform/run-restore-drill-validate.ts` issues only
  `SELECT` statements.
- Validation output is row counts and pass/fail booleans only -- no email
  addresses, names, or credential material are ever printed or logged.
- Both the restored sibling and the validator service are deleted at the
  end of the run, success or failure (`if: always()` in the workflow).

## Automated run

```
GitHub Actions -> town-api -> "Production restore drill" -> Run workflow
```

Optional input `restore_minutes_ago` (default `3`): how far back from "now"
to target. The default picks a point almost certainly already covered by
the WAL archive without digging into history.

The workflow (`.github/workflows/restore-drill.yml`):

1. `railway postgres pitr status --service Postgres-9UWs` -- confirms the
   archiver is healthy before attempting anything.
2. `railway postgres pitr restore --service Postgres-9UWs --at <timestamp>
--new-service-name restore-drill-<run id> --yes` -- starts an
   **asynchronous** background provisioning workflow on Railway's side and
   returns immediately. Records `restore_point_at` (the target) and
   `drill_start` (RTO clock start, taken right before this command).
3. Polls the restored sibling's own deploy logs (`railway logs`) for
   `database system is ready to accept connections`, for up to 30 minutes.
   Two live runs took 8-15 minutes for Postgres itself to become ready.
4. Deploys a throwaway **validator service** into the same Railway
   project+environment as the restored sibling, sourced from this repo,
   with its `DATABASE_URL` set to a Railway private-network reference
   variable (`${{<sibling>.DATABASE_URL}}`) pointing at the sibling, and a
   start command of `node dist/scripts/restore-drill-validate.js`. Because
   it's an ordinary Railway service in the same project+environment, it
   reaches the sibling over `<service>.railway.internal` -- the same path
   the real `town-api` service uses to reach `Postgres-9UWs` -- with no
   tunnel and no public exposure. Polls the deployment to a terminal
   status, then reads its own deploy logs for the validation script's JSON
   summary.
5. Prints RPO, RTO, and the exact JSON body for the attestation call.
6. Deletes both the restored sibling and the validator service,
   unconditionally.

Creating, configuring, and deploying the validator service goes through
`railway api` (raw GraphQL) since the CLI has no `service create`
subcommand -- see "Why raw GraphQL" below.

### Why raw GraphQL, and why not the SSH tunnel

Earlier versions of this workflow used `railway connect --tunnel-only` to
reach the restored sibling from the GitHub Actions runner directly. Three
live production runs showed that path is unreliable specifically against
freshly PITR-restored sibling services: the SSH tunnel opened in about a
second every time, but `psql` got `server closed the connection
unexpectedly` on every attempt, for the full length of an 80-minute wait
budget -- even long after the restored Postgres's own deploy logs showed it
was ready and accepting connections. A dedicated diagnostic workflow then
confirmed the exact same tunnel mechanism worked fine, first try, against
an ordinary already-existing service (staging Postgres) -- isolating the
problem to something in how Railway wires up the SSH-tunnel relay for
newly created siblings specifically, not a timing issue and not fixable by
waiting longer.

The fix is to not use that path at all. A validator deployed as an
ordinary Railway service in the same project+environment reaches the
sibling over Railway's private network, the same way any other service in
a Railway project reaches another -- proven in a live investigation run,
all 22 integrity checks passing within a second of the validator
container starting.

The Railway CLI doesn't have a `service create` subcommand, so creating
that throwaway validator has to go through `railway api` (raw GraphQL) --
the same escape hatch `rollback-staging.yml` already uses for
`deploymentRollback`. That workflow's own history shows guessing
mutation/field names caused two real failures before schema introspection
fixed it, so the mutations here (`serviceCreate`, `serviceInstanceUpdate`,
`serviceInstanceDeployV2`, the `deployment`/`deploymentLogs` queries) were
all confirmed against the live schema via `railway api describe` /
`railway api search` before being used, not guessed.

One schema detail worth knowing if this ever needs debugging: Railway's
log pipeline parses JSON stdout lines into structured `attributes`
(key/value pairs) rather than keeping the raw JSON as a single `message`
string. The validation script's JSON summary line shows up as
`attributes: [{key: "outcome", value: "\"passed\""}, {key: "checks",
value: "[...]"}, ...]`, not as `message`. Each attribute value is itself a
JSON-encoded string (double-encoded), so reading it back out needs a
second `JSON.parse`.

## What gets validated

`src/platform/run-restore-drill-validate.ts` (compiled to
`dist/scripts/restore-drill-validate.js` for the validator service;
`scripts/restore-drill-validate.ts` is the equivalent `tsx` entrypoint for
local/manual runs) connects only to the `DATABASE_URL` it's given (must be
the restored sibling) and checks, read-only:

- Connectivity and that the `town` schema exists.
- The expected core tables are present.
- Row counts for accounts, communities, membership entitlements, platform
  operators (roles), actors, civic processes/proposals/votes, and the
  authentication tables (passkey credentials, password credentials,
  sessions).
- Foreign-key/orphan integrity: memberships -> accounts, operators ->
  accounts, actors -> accounts/communities, proposals -> processes/actors,
  processes -> communities.
- Authentication data structurally intact: every passkey credential row has
  non-empty credential/public-key material, every password credential row
  has a non-empty hash. This is the "test authentication" requirement,
  done without connecting any application or exposing the restored
  instance to traffic.

Exit code is non-zero if any check fails; the script prints a single JSON
summary line (`outcome`, per-check results, counts) and nothing else.

## RPO / RTO

- **RPO** (data-loss window) = `drill_start - restore_point_at`. This is
  the age of the restore point relative to the moment the drill was
  initiated -- the worst-case data loss window a real incident at that
  moment would have implied, bounded by the WAL archiver's push cadence
  (commits are archived continuously; `archive_timeout` forces a push at
  least every 60s even when idle).
- **RTO** (time to a validated, usable restore) = time from issuing the
  restore command to the validator reporting `passed`.
- Threshold from the plan: RPO <= 15 minutes, RTO <= 60 minutes, or a new
  accepted threshold recorded here after a real run if those aren't met.
  Live runs on 2026-08-13 measured RPO of 180s (3 minutes, the input
  default) and Postgres readiness alone at 8-15 minutes -- both comfortably
  inside threshold.

## Credentials

`railway postgres pitr restore` and the `railway api` service-management
mutations are account/workspace-level operations, not project-level ones.
The Railway CLI has two separate, mutually exclusive auth env vars
(setting both errors out):

- `RAILWAY_TOKEN` -- project-scoped, generated from a project's own tokens
  page. Sufficient for `railway up` / `railway variable set`, but gets
  `Unauthorized` on `pitr restore` and on service-management mutations.
- `RAILWAY_API_TOKEN` -- account or workspace-scoped, generated from
  **Account Settings > Tokens** (`railway.com/account/tokens`), not from
  inside the project. Required for `pitr restore`, `service delete`, and
  `railway api`.

This workflow uses a dedicated `RAILWAY_ACCOUNT_TOKEN` GitHub secret (an
Account token, "No workspace" scope) passed to the CLI as `RAILWAY_API_TOKEN`
-- deliberately separate from the `RAILWAY_TOKEN` project token that
`ci.yml`'s deploy jobs use, so this workflow can't accidentally widen or
narrow those jobs' credentials.

### GitHub Actions minutes

Each run costs real GitHub Actions minutes against the repository's
included-usage quota (or a configured spending budget once that's
exhausted -- confirmed on 2026-08-13 that Actions minutes and "AI Credit"
usage are billed under separate budgets/SKUs in GitHub's billing UI, so a
budget created for one does not cover the other). A run now takes roughly
15-45 minutes (dominated by the Postgres-readiness wait), well under the
`timeout-minutes: 60` cap -- much cheaper than the earlier tunnel-based
version, which could run the full 80-110 minutes on every failure.

## Recording the attestation

The workflow's own operator identity has no passkey session, so it cannot
call the platform API itself (`POST /v1/platform/restore/attest` requires
an authenticated `ops_admin`+ operator -- by design, there is no
service-account bypass for this). Submit the printed JSON body yourself,
signed in as a platform operator:

```
POST https://api.towncivic.org/v1/platform/restore/attest
Content-Type: application/json

{
  "method": "railway_pitr_point_in_time",
  "outcome": "passed",
  "restorePointAt": "<from the workflow run's output>",
  "note": "drill run <run id>; RPO=<seconds>s RTO=<seconds>s"
}
```

## Manual equivalent (CLI, no CI)

Creating the validator service by hand is easiest from the Railway
dashboard (New Service -> GitHub Repo -> town-api -> set the start command
and `DATABASE_URL` in Settings), not the CLI, since `railway` has no
`service create` subcommand. The rest works from a terminal:

```bash
railway postgres pitr status --service Postgres-9UWs --environment production

RESTORE_AT=$(date -u -d '3 minutes ago' '+%Y-%m-%dT%H:%M:%SZ')
railway postgres pitr restore \
  --service Postgres-9UWs --environment production \
  --at "$RESTORE_AT" --new-service-name restore-drill-manual --yes
# Async -- wait for "database system is ready to accept connections" in
# `railway logs --service restore-drill-manual --environment production`
# before creating the validator.

# In the Railway dashboard: New Service -> GitHub Repo -> town-api,
# environment production, name e.g. restore-drill-validator-manual.
# Settings -> Variables: DATABASE_URL = ${{restore-drill-manual.DATABASE_URL}}
# Settings -> Deploy: Start Command = node dist/scripts/restore-drill-validate.js
# Restart Policy = Never. Then deploy, and read its deploy logs for the
# JSON summary.

railway service delete --service restore-drill-validator-manual --environment production --yes
railway service delete --service restore-drill-manual --environment production --yes
```

## If a run fails

- **PITR status unhealthy**: stop, do not restore. File a follow-up before
  the next scheduled drill; production's actual recovery capability is
  unverified until this is fixed.
- **Restore times out / sibling never reachable**: read the "Deploy logs"
  and "Build logs" groups the wait step prints right before it fails --
  they're pulled from the restored service itself, before cleanup deletes
  it. `FATAL: the database system is starting up` / `in recovery mode`
  means WAL replay is genuinely still running (the fix is a longer wait
  budget, not a code change); `Connection refused` or no deploy logs at
  all means Postgres never started listening (check the build logs and
  the Railway dashboard for a provisioning failure before assuming this is
  a timing issue).
- **Validator service creation/deploy fails**: the `serviceCreate` /
  `serviceInstanceUpdate` / `serviceInstanceDeployV2` steps each print the
  raw GraphQL response before parsing it, so a schema or permissions error
  is visible directly in the job output. Re-run
  `.github/workflows/railway-api-introspect.yml` (or `railway api
  describe <Type>` by hand) against the live schema before changing a
  mutation shape -- don't guess field names.
- **Validation fails**: do not delete the sibling automatically -- the
  workflow still deletes both services (nothing here should be treated as
  a substitute for production data, and keeping a stale isolated copy
  around is its own risk) but capture the failing check names and counts
  from the job output before they're gone, then escalate.

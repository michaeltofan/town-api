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
validates the data there, and deletes it.

Non-negotiable properties of every run:

- The production Postgres service (`Postgres-9UWs`) is the read-only WAL
  source and is never written to, restored over, or restarted.
- The restored sibling service never receives application traffic: no app
  service is ever pointed at it, and it gets no public domain.
- No migrations, seeds, or writes of any kind run against the restored
  sibling. `scripts/restore-drill-validate.ts` issues only `SELECT`
  statements.
- Validation output is row counts and pass/fail booleans only -- no email
  addresses, names, or credential material are ever printed or logged.
- The restored sibling is deleted at the end of the run, success or failure
  (`if: always()` in the workflow).

## Automated run

```
GitHub Actions -> town-api -> "Production restore drill" -> Run workflow
```

Optional input `restore_minutes_ago` (default `3`): how far back from "now"
to target. The default picks a point almost certainly already covered by
the WAL archive without digging into history.

The workflow (`.github/workflows/restore-drill.yml`):

1. Generates a fresh, throwaway ed25519 keypair and registers the public
   half with `railway ssh keys add`. The restored sibling has no public
   TCP proxy, so `railway connect --tunnel-only` always falls back to an
   SSH tunnel, which requires a key registered on the account -- a bare CI
   runner has none by default.
2. `railway postgres pitr status --service Postgres-9UWs` -- confirms the
   archiver is healthy before attempting anything.
3. `railway postgres pitr restore --service Postgres-9UWs --at <timestamp>
--new-service-name restore-drill-<run id> --yes` -- starts an
   **asynchronous** background provisioning workflow on Railway's side and
   returns immediately (confirmed from live output: "This runs in the
   background; the new service will appear in the dashboard once
   provisioning completes."). Records `restore_point_at` (the target) and
   `drill_start` (RTO clock start, taken right before this command).
4. Opens a private SSH tunnel to the new service only (`railway connect
--tunnel-only`; the restored service has no public TCP proxy, so this is
   the only reachable path) and polls until it accepts connections --
   up to 90 attempts, ~35s apart, since provisioning a production-sized
   restore can itself take several minutes before the service even exists.
5. Runs `npm run restore-drill:validate` against the tunnel -- see below.
6. Prints RPO, RTO, and the exact JSON body for the attestation call.
7. Deletes the restored sibling service, unconditionally.

## What gets validated

`scripts/restore-drill-validate.ts` connects only to the URL it's given
(must be the restored sibling) and checks, read-only:

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
  restore command to the validation script reporting `passed`.
- Threshold from the plan: RPO <= 15 minutes, RTO <= 60 minutes, or a new
  accepted threshold recorded here after a real run if those aren't met.

## Credentials

`railway postgres pitr restore` creates a new service, which is an
account/workspace-level operation, not a project-level one. The Railway CLI
has two separate, mutually exclusive auth env vars (setting both errors
out):

- `RAILWAY_TOKEN` -- project-scoped, generated from a project's own tokens
  page. Sufficient for `railway up` / `railway variable set`, but gets
  `Unauthorized` on `pitr restore`.
- `RAILWAY_API_TOKEN` -- account or workspace-scoped, generated from
  **Account Settings > Tokens** (`railway.com/account/tokens`), not from
  inside the project. Required for `pitr restore` and `service delete`.

This workflow uses a dedicated `RAILWAY_ACCOUNT_TOKEN` GitHub secret (an
Account token, "No workspace" scope) passed to the CLI as `RAILWAY_API_TOKEN`
-- deliberately separate from the `RAILWAY_TOKEN` project token that
`ci.yml`'s deploy jobs use, so this workflow can't accidentally widen or
narrow those jobs' credentials.

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

If `railway connect` reports "no SSH keys found", register one first:
`ssh-keygen -t ed25519` then `railway ssh keys add --key ~/.ssh/id_ed25519.pub`.
Most machines that already use `railway ssh` day to day have one registered.

```bash
railway postgres pitr status --service Postgres-9UWs --environment production

RESTORE_AT=$(date -u -d '3 minutes ago' '+%Y-%m-%dT%H:%M:%SZ')
railway postgres pitr restore \
  --service Postgres-9UWs --environment production \
  --at "$RESTORE_AT" --new-service-name restore-drill-manual --yes
# This starts an async background workflow -- wait a few minutes and check
# the Railway dashboard before the next step, the new service is not
# necessarily up yet even though this command returns immediately.

railway connect restore-drill-manual --environment production --tunnel-only
# in another shell, using the printed connection URL:
DATABASE_URL="<printed URL>" npm run restore-drill:validate

railway service delete --service restore-drill-manual --environment production --yes
```

## If a run fails

- **PITR status unhealthy**: stop, do not restore. File a follow-up before
  the next scheduled drill; production's actual recovery capability is
  unverified until this is fixed.
- **Restore times out / sibling never reachable**: check the new service's
  deploy logs in the Railway dashboard before retrying. Delete the stuck
  sibling manually if the workflow's cleanup step couldn't reach it.
- **Validation fails**: do not delete the sibling automatically -- the
  workflow still deletes it (nothing here should be treated as a
  substitute for production data, and keeping a stale isolated copy around
  is its own risk) but capture the failing check names and counts from the
  job output before it's gone, then escalate.

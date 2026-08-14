# Capacity drill runbook (Etapa 4)

Etapa 4 of the TOWN deployment plan: prove the API holds up under a
realistic, write-capable load of ~1,000 users -- feed, detail, login,
confirm, propose, and vote -- twice consecutively, with real evidence that
zero votes/proposals were duplicated, zero writes were lost, and zero
cross-community access slipped through.

## Why this targets a permanent, dedicated environment

Two earlier designs were tried and abandoned before this one:

1. **Ephemeral rows in the shared Staging Postgres.** Not possible:
   `civic_process_events` / `civic_process_transitions` are unconditionally
   append-only from the moment a signal is created
   (`drizzle/0041_civic_process_confirmation.sql`), with `RESTRICT` foreign
   keys back to `signals` and `communities` -- every signal ever created
   becomes permanently undeletable. Confirmed the hard way when
   `emergency-teardown.yml` hit `error: civic process ledger is
append-only` against leftover rows.
2. **A temporary Postgres + API service created and destroyed on every
   run**, via raw `serviceCreate`/`volumeCreate` GraphQL calls. Two real
   dispatches of that design failed on Railway infrastructure races before
   ever reaching the k6 step -- the first because the Postgres service was
   never given a volume to mount, the second because a redeploy triggered
   too soon after a config change picked up a stale snapshot and restarted
   the previous one-shot migration command instead of the server. Neither
   failure said anything about TOWN's actual capacity; both cost a full
   wait cycle to diagnose.

The fix is to stop provisioning infrastructure per run. A permanent,
dedicated Railway environment named `capacity` (project `town-public`,
environment id `b1cd4997-02b8-4103-bd64-bfc970e0e7cc`) holds exactly two
standing services, provisioned once by hand and never recreated by CI:

- **Postgres** (official Railway Postgres template, not a manually built
  image+volume) -- service `Postgres-ykVK`, id
  `8221a7d3-835b-4d5e-ac2a-4216f43aa48c`.
- **`town-api-capacity`** (this repo, branch `main`) -- id
  `992fd678-aa3c-4fe2-8295-921ec6c2f2a5`, `DATABASE_URL` wired to
  Postgres-ykVK over Railway's private network, public domain
  `town-api-capacity-capacity.up.railway.app` (generated once, not
  regenerated per run).

`.github/workflows/capacity-drill.yml` never creates or deletes either
service. Instead, before each of the drill's two runs, it resets the
_database schema_ -- not the service -- back to empty and re-migrates. This
sidesteps the append-only row triggers the same way the temporary-service
design did (dropping a schema doesn't fire row-level DML triggers), without
any of the service/volume/networking provisioning that kept failing.

This workflow never uses the shared Staging Postgres, never touches
production, never disables the append-only triggers, and never deletes
individual civic-registry rows.

## What this does

`.github/workflows/capacity-drill.yml` runs the same cycle twice, back to
back, against the fixed `capacity` environment:

1. **Setup** -- `town-api-capacity` redeploys with `startCommand: node
dist/scripts/capacity-setup.js`
   (`src/platform/run-capacity-setup.ts`), which:
   - **Resets the schema.** `resetCapacitySchema()` drops and recreates the
     `town` and `drizzle` Postgres schemas. It refuses unconditionally
     unless Railway's own `RAILWAY_ENVIRONMENT_NAME` variable is exactly
     `capacity` -- the one strict guard required before this destructive
     step, confirmed to be genuinely auto-injected by Railway (not
     something the workflow sets), so it can't be silently pointed at the
     wrong database.
   - **Migrates** -- `runMigrations()` (`src/db/run-migrations.ts`), the
     same advisory-locked entrypoint the real production migration step
     uses.
   - **Seeds and provisions fixtures** -- `runStagingSeed()`
     (`src/db/run-staging-seed.ts`) for canonical foundation content, then
     the capacity-drill communities, signals, and accounts using **fixed
     IDs** (`src/platform/capacity-drill/fixtures.ts`) -- safe only because
     the schema reset guarantees the database is empty every run. See
     `loadtest/README.md` for why fixed IDs replace a manifest-file
     handoff.
2. **Serve** -- redeploys with `startCommand: node dist/server.js` (this
   repo's normal container CMD), then the workflow polls
   `GET /health/ready` on the fixed public domain until it reports
   `{"status":"ready"}` -- a real signal, since that endpoint checks both
   Postgres connectivity and the migration ledger
   (`src/routes/health.ts`), not a log-string guess.
3. **k6** -- `loadtest/capacity-1000.js` runs from the GitHub Actions
   runner against the fixed public domain: 100 VUs for 30 minutes, then a
   200-VU/5-minute spike.
4. **Verify** -- redeploys with `startCommand: node
dist/scripts/capacity-verify.js`
   (`src/platform/run-capacity-verify.ts`), a read-only DB-level check for
   duplicate/cross-community confirmations, proposals, and ballot tokens,
   that every consumed ballot token has exactly one matching vote row, and
   a `pg_stat_activity`/`pg_locks` snapshot taken after the k6 load.

Run 2 only starts if Run 1's k6 thresholds _and_ verify outcome both
passed (`steps.run1_final.outputs.passed == 'true'` gates every Run 2
step) -- a failed first run never wastes a second cycle.

Full detail on the fixtures and the k6 scenario itself is in
`loadtest/README.md`. This runbook is about running the whole thing end to
end in CI.

## Running it

```
GitHub Actions -> town-api -> "Etapa 4 capacity drill" -> Run workflow
```

Manual dispatch only -- never runs on push or PR. Expect roughly 80-100
minutes total for both runs (each cycle: schema reset + migrate + seed +
provision, a serve redeploy, the ~37-minute k6 run, and a verify redeploy);
`timeout-minutes: 180` leaves margin.

`town-api-capacity` is reached only through its fixed public domain
(`https://town-api-capacity-capacity.up.railway.app`); Postgres-ykVK is
reached only over Railway's private network via the `DATABASE_URL`
reference variable already wired into `town-api-capacity` -- there is no
SSH tunnel and no public Postgres exposure anywhere in this workflow. The
Railway GraphQL mutations used (`serviceInstanceUpdate`,
`serviceInstanceDeployV2`, `deployment` status polling, `deploymentLogs`)
are the same ones `restore-drill.yml` already proved reliable; no
`serviceCreate`, `volumeCreate`, or domain-generation calls remain in this
workflow at all.

## What gets collected, and where to look

- **Throughput, p50/p95/p99, 4xx/5xx**: k6's own summary
  (`run{1,2}-k6-summary.json` in the job's uploaded artifact, plus a
  human-readable summary in the step log). k6's built-in
  `http_req_failed` is **not** the right number to read for this
  scenario -- it counts every deliberate rejection (duplicate vote,
  cross-community denial) as a "failure". Read `unexpected_failure_rate`
  and `server_error_rate` instead; see `loadtest/README.md` for why.
- **Zero duplicate votes/proposals, zero lost writes, zero
  cross-community access**: `run{1,2}-verify.txt` in the job's uploaded
  artifact -- the definitive evidence for the plan's closing bar, not an
  inference from k6 thresholds passing. A `"outcome": "failed"` here is
  disqualifying regardless of how clean the k6 thresholds looked.
- **PostgreSQL connections and locks**: the `db_connections_and_locks`
  check inside each run's `run{1,2}-verify.txt` -- a `pg_stat_activity` /
  `pg_locks` count snapshot taken immediately after that run's k6 load.
- **CPU and RAM**: not collected by the workflow itself. Because
  `town-api-capacity` is now permanent standing infrastructure (not
  deleted after the run), its Railway Metrics tab remains available after
  the drill completes -- read it from the Railway dashboard, or via the
  Railway MCP `get-service-metrics` tool, for the run's time window,
  before the environment is stopped or deleted.
- **Job summary**: the workflow run's own Summary tab shows both runs'
  k6 summaries and verify outcomes inline, without opening the artifact.

## If a run fails

- **k6 thresholds fail** (`p95`/`p99`, `unexpected_failure_rate`,
  `server_error_rate`): the k6 step itself exits non-zero
  (`continue-on-error: true` so the verify step still runs afterward, to
  capture DB-level evidence either way). Read the printed k6 summary for
  which threshold and by how much; the exact `capacity-1000.js` requests
  behind each `endpoint` tag are documented in `loadtest/README.md`.
- **A verify phase reports `"outcome": "failed"`**: read `checks` in the
  corresponding `run{1,2}-verify.txt` for which invariant broke and the
  row count involved. This is the one failure mode that must never be
  waved through -- it means a concurrency bug let something through that a
  unique constraint or an authorization gate was supposed to prevent.
- **A setup phase fails** (schema reset/migrate/seed/provision): read the
  deploy logs for that run's setup deployment (the workflow prints the raw
  `deploymentLogs` response on failure). A `reset_schema` check failure
  almost always means `RAILWAY_ENVIRONMENT_NAME` didn't resolve to
  `capacity` -- investigate before assuming anything about migrations.
- **Run 1 fails**: Run 2 does not start (`steps.run1_final.outputs.passed
== 'true'` gates every Run 2 step). The job still reports overall
  failure.
- **`town-api-capacity` or Postgres-ykVK end up unhealthy after a run**:
  neither is deleted automatically. Redeploy `town-api-capacity` by hand
  (Railway dashboard, `capacity` environment) once the underlying issue is
  fixed; nothing needs to be recreated.

## Results

_(Filled in after the first real run of the permanent-environment
workflow -- see Etapa 4's status in the deployment plan.)_

# Capacity drill runbook (Etapa 4)

Etapa 4 of the TOWN deployment plan: prove the API holds up under a
realistic, write-capable load of ~1,000 users -- feed, detail, login,
confirm, propose, and vote -- with real evidence that zero votes/proposals
were duplicated, zero writes were lost, and zero cross-community access
slipped through.

## Why this runs in a temporary, isolated environment

Earlier iterations provisioned an ephemeral dataset directly in the shared
Staging Postgres and deleted it afterward. That design is no longer
possible: `civic_process_events` / `civic_process_transitions` are
unconditionally append-only from the moment a signal is created
(`drizzle/0041_civic_process_confirmation.sql`, `BEFORE UPDATE OR DELETE`
triggers with no exception), and `civic_process_events.process_id` /
`civic_processes.signal_id` are both `ON DELETE RESTRICT` -- so every
signal ever created, and transitively its community, becomes permanently
undeletable the instant it exists. There is no row-level teardown that can
work against a shared, persistent database, regardless of how carefully
scoped -- this was discovered when `emergency-teardown.yml` failed against
leftover rows from an earlier drill with `error: civic process ledger is
append-only`.

The fix is architectural: run the entire drill against a **brand-new,
empty, temporary Postgres and a temporary API service**, both created
fresh for one run and deleted as whole Railway services afterward.
Deleting a service doesn't fire row-level DML triggers, so the append-only
protection never needs to be touched, bypassed, or weakened. This
workflow never uses the shared Staging Postgres, never touches
production, never disables the append-only triggers, and never deletes
individual civic-registry rows.

## What this does

`.github/workflows/capacity-drill.yml` runs once, end to end:

1. **Create a temporary Postgres** -- a brand-new Railway service (the
   same `postgres-ssl` image the project's real Postgres services use),
   empty, created fresh for this run only.
2. **Create a temporary API service** at this workflow's commit (`branch:
main`, dispatched immediately after merge with no intervening commits,
   so it is the exact SHA that passed CI), pointed at the temporary
   Postgres via a Railway private-network reference variable.
3. **Apply migrations** -- the temporary API service redeploys with
   `startCommand: node dist/scripts/capacity-setup.js`, which calls the
   same `runMigrations()` (`src/db/run-migrations.ts`) the real production
   migration step uses.
4. **Load the deterministic seed and fixtures** -- the same one-shot
   script then calls `runStagingSeed()` (`src/db/run-staging-seed.ts`) for
   canonical foundation content, then provisions the capacity-drill
   communities, signals, and accounts using **fixed IDs**
   (`src/platform/capacity-drill/fixtures.ts`) -- safe only because the
   database is guaranteed brand-new and empty every run. See
   `loadtest/README.md` for why fixed IDs replace the older
   manifest-file handoff.
5. **Run the Etapa 4 capacity profile** -- the temporary API service
   redeploys again with `startCommand: node dist/server.js` (the real
   production entrypoint), gets a public `*.up.railway.app` domain, and
   `loadtest/capacity-1000.js` runs from the GitHub Actions runner against
   that domain: 100 VUs for 30 minutes, then a 200-VU/5-minute spike.
6. **Verify** -- the temporary API service redeploys a third time with
   `startCommand: node dist/scripts/capacity-verify.js`
   (`src/platform/run-capacity-verify.ts`), a read-only DB-level check for
   duplicate/cross-community confirmations, proposals, and ballot tokens,
   and that every consumed ballot token has exactly one matching vote row.
7. **Delete both temporary services** -- `if: always()`, including if any
   earlier step failed, via `railway service delete` (the same CLI verb
   `restore-drill.yml` already uses for its own cleanup).

Full detail on the fixtures and the k6 scenario itself is in
`loadtest/README.md`. This runbook is about running the whole thing end to
end in CI.

## Running it

```
GitHub Actions -> town-api -> "Etapa 4 capacity drill" -> Run workflow
```

Manual dispatch only -- never runs on push or PR. Expect roughly 45-70
minutes total (temporary Postgres readiness + three sequential API
redeploys + the ~37-minute k6 run + verification); `timeout-minutes: 90`
leaves margin.

The temporary Postgres and API service are reached only through Railway's
private network (`<service>.railway.internal`, via a
`${{ServiceName.DATABASE_URL}}` reference variable) or, for k6, the
temporary API service's own public `*.up.railway.app` domain -- there is
no SSH tunnel anywhere in this workflow. Every Railway GraphQL mutation
used (`serviceCreate`, `serviceInstanceUpdate`, `serviceInstanceDeployV2`,
`deployment` status polling, `deploymentLogs`) is the same one
`restore-drill.yml` already proved reliable for its own throwaway
validator service; `railway service delete` is the same CLI verb
`restore-drill.yml` uses for cleanup; `railway domain` (used once, to
obtain the temporary API service's public endpoint for k6) is the same
category of documented, stable Railway CLI surface.

## What gets collected, and where to look

- **Throughput, p50/p95/p99, 4xx/5xx**: k6's own summary
  (`capacity-k6-summary.json` in the job's uploaded artifact, plus a
  human-readable summary in the step log). k6's built-in
  `http_req_failed` is **not** the right number to read for this
  scenario -- it counts every deliberate rejection (duplicate vote,
  cross-community denial) as a "failure". Read `unexpected_failure_rate`
  and `server_error_rate` instead; see `loadtest/README.md` for why.
- **Zero duplicate votes/proposals, zero lost writes, zero
  cross-community access**: `verify_result.txt` in the job's uploaded
  artifact -- the definitive evidence for the plan's closing bar, not an
  inference from k6 thresholds passing. A `"outcome": "failed"` here is
  disqualifying regardless of how clean the k6 thresholds looked.
- **Job summary**: the workflow run's own Summary tab shows the commit,
  the k6 summary, and the verify outcome inline, without opening the
  artifact.
- **CPU and RAM**: not collected by this workflow. The temporary API
  service is deleted immediately after the run, so its Railway Metrics
  tab is gone by the time anyone could read it; if this matters for a
  future iteration, it would need to be read from `deploymentLogs` or a
  Railway metrics query introduced deliberately (with its own schema
  confirmation, not guessed), not added silently to this workflow.

## If a run fails

- **k6 thresholds fail** (`p95`/`p99`, `unexpected_failure_rate`,
  `server_error_rate`): the k6 step itself exits non-zero (`continue-on-
error: true` so the verify and cleanup steps still run afterward). Read
  the printed k6 summary for which threshold and by how much; the exact
  `capacity-1000.js` requests behind each `endpoint` tag are documented in
  `loadtest/README.md`. The job's own final step still fails overall.
- **The verify phase reports `"outcome": "failed"`**: read `checks` in
  `verify_result.txt` for which invariant broke and the row count
  involved. This is the one failure mode that must never be waved
  through -- it means a concurrency bug let something through that a
  unique constraint or an authorization gate was supposed to prevent.
- **The setup phase fails** (migrate/seed/provision): read the deploy
  logs for the temporary API service's setup deployment (the workflow
  prints the raw `deploymentLogs` response on failure). Common causes:
  the temporary Postgres wasn't actually ready yet (should not happen --
  the workflow waits for `database system is ready to accept
connections` in its deploy logs before creating the API service), or a
  schema drift between the migrations in this commit and what
  `runStagingSeed()`/the provisioning fixtures expect.
- **Cleanup fails** (`railway service delete` for either temporary
  service): the step logs a `::warning::` and continues rather than
  failing the job, since cleanup runs under `if: always()` and must not
  mask an earlier real failure. Delete the orphaned service manually from
  the Railway dashboard (staging environment, look for
  `capacity-drill-pg-<run-id>` / `capacity-drill-api-<run-id>`).
- **Job times out**: both temporary services are still real Railway
  services if the job is cancelled or times out before the cleanup step
  runs. Check the Railway dashboard (staging environment) for any
  `capacity-drill-pg-*` / `capacity-drill-api-*` services and delete them
  by hand.

## Results

_(Filled in after the first real run of the isolated-environment
workflow -- see Etapa 4's status in the deployment plan.)_

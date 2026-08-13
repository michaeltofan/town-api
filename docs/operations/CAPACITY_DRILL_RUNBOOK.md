# Capacity drill runbook (Etapa 4)

Etapa 4 of the TOWN deployment plan: prove staging holds up under a
realistic, write-capable load of ~1,000 users -- feed, detail, login,
confirm, propose, and vote -- twice consecutively, with real evidence that
zero votes/proposals were duplicated, zero writes were lost, and zero
cross-community access slipped through.

## What this does

`.github/workflows/capacity-drill.yml` runs, twice in a row:

1. **Provision** (`loadtest/provision.ts`) -- builds a fully ephemeral
   dataset: two communities, ~23 signals, ~250 real login-capable
   accounts. Torn down at the end of the same run.
2. **Ensure voting arena** (`loadtest/ensure-voting-arena.ts`) -- makes
   sure the small permanent voting fixture (8 signals already at
   `voting`, 40 voter accounts) exists and has fresh passwords. Never torn
   down (see `src/db/seeds/loadtest-voting-arena.ts` for why).
3. **k6** (`loadtest/capacity-1000.js`) -- 100 VUs for 30 minutes, then a
   200-VU/5-minute spike, against `https://api-staging.towncivic.org`.
4. **Verify** (`loadtest/verify.ts`) -- read-only DB-level proof that no
   duplicate confirmations/proposals/ballot tokens and no cross-community
   rows exist for the communities this run touched, and that every
   consumed ballot token has exactly one matching vote row.
5. **Teardown** (`loadtest/teardown.ts`) -- deletes everything step 1
   created. Refuses (rather than silently skipping) if it ever finds rows
   in the append-only `civic_ballot_eligible_actors` table for the
   ephemeral communities -- that would mean an ephemeral signal reached
   `ballot_preparation`, which should be structurally impossible (see
   `loadtest/provision.ts`'s doc comment) and needs investigation, not
   cleanup.

Full detail on the scripts themselves -- what accounts/data look like, why
writes are safe against real staging content, why votes/payments can't be
duplicated -- is in `loadtest/README.md`. This runbook is about running
the whole thing end to end in CI.

## Running it

```
GitHub Actions -> town-api -> "Etapa 4 capacity drill" -> Run workflow
```

Manual dispatch only -- never runs on push or PR, so it never competes
with real staging traffic unless someone deliberately starts it. Expect
roughly 70-110 minutes total (dominated by the two ~37-minute k6 runs);
`timeout-minutes: 180` leaves comfortable margin.

Each of provision/ensure-voting-arena/verify/teardown reaches staging
Postgres through a fresh `railway connect --tunnel-only` SSH tunnel per
invocation (`scripts/ci/with-staging-tunnel.sh`), not one held open for
the whole job -- so a flaky tunnel on one step doesn't take down the
whole run, and each script gets its own 6-attempt retry budget. This
mechanism is proven reliable specifically against an _already-existing_
Railway service (a dedicated diagnostic run during Etapa 3 confirmed it
works first try against staging Postgres); its known unreliability is
specific to freshly PITR-restored siblings, which is not what this
workflow ever touches -- see
[`RESTORE_DRILL_RUNBOOK.md`](./RESTORE_DRILL_RUNBOOK.md) for that
investigation. k6 itself talks to staging's public HTTPS API directly,
never through the tunnel.

## What gets collected, and where to look

- **Throughput, p50/p95/p99, 4xx/5xx**: k6's own summary
  (`run{1,2}-k6-summary.json` in the job's uploaded artifact, plus a
  human-readable summary in the step log). k6's built-in
  `http_req_failed` is **not** the right number to read for this
  scenario -- it counts every deliberate rejection (duplicate vote,
  cross-community denial) as a "failure". Read `unexpected_failure_rate`
  and `server_error_rate` instead; see `loadtest/README.md` for why.
- **PostgreSQL connections and locks**: `run{N}-db-before.txt` /
  `run{N}-db-after.txt`, a plain `pg_stat_activity` / `pg_locks` count
  taken immediately before and after each k6 run.
- **CPU and RAM**: read manually from the Railway dashboard (town-api
  staging service -> Metrics tab) for the drill's time window, for now.
  This workflow does not fetch them automatically -- the Railway metrics
  GraphQL schema was not introspected/validated as part of building this
  workflow, and this project's established practice (see
  `rollback-staging.yml`, `restore-drill.yml`) is to introspect the live
  schema before writing any `railway api` query, never guess field names.
  A future iteration can add this the same way `restore-drill.yml`'s
  validator-service mutations were confirmed, if automating it turns out
  to matter.
- **Zero duplicate votes/proposals, zero lost writes, zero
  cross-community access**: `run{N}-verify.json` -- the definitive
  evidence for the plan's closing bar, not an inference from thresholds
  passing. A `"outcome": "failed"` here is disqualifying regardless of
  how clean the k6 thresholds looked.
- **Job summary**: the workflow run's own Summary tab shows both runs'
  verify outcomes inline, without opening the artifact.

## If a run fails

- **k6 thresholds fail** (`p95`/`p99`, `unexpected_failure_rate`,
  `server_error_rate`): the step itself exits non-zero. Read the printed
  k6 summary for which threshold and by how much; the exact
  `capacity-1000.js` requests behind each `endpoint` tag are documented
  in `loadtest/README.md`.
- **verify.ts reports `"outcome": "failed"`**: read `checks` in the
  printed JSON for which invariant broke and the row count involved. This
  is the one failure mode that must never be waved through -- it means a
  concurrency bug let something through that a unique constraint or an
  authorization gate was supposed to prevent.
- **teardown.ts refuses** (`civic_ballot_eligible_actors` rows found for
  the ephemeral communities): do not force a delete. That table is
  append-only for the same reason production civic processes can't be
  deleted once they reach voting -- investigate why an ephemeral signal
  reached `ballot_preparation` (it shouldn't be able to, since
  `capacity-1000.js`'s ephemeral-pool journey never submits deliberation
  contributions) before touching this data by hand.
- **Tunnel step fails after 6 attempts**: re-run the workflow. If it
  fails repeatedly, confirm staging Postgres is actually healthy first
  (Railway dashboard) before assuming the tunnel mechanism itself
  regressed -- it's the same mechanism Etapa 3 validated, not new code
  each run.
- **Job times out**: the "Final safety-net teardown" step still runs on
  `always()` up to that point, but a hard job timeout can end the run
  before that step starts. Manually run `loadtest/teardown.ts` (see
  `loadtest/README.md`) against staging afterward to confirm the
  ephemeral pool was actually cleaned up.

## Results

_(Filled in after the first real two-run drill -- see Etapa 4's status in
the deployment plan.)_

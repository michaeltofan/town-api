# Staging capacity tests

Two [k6](https://k6.io) scripts, both **staging only**
(`https://api-staging.towncivic.org`):

- `staging-capacity.js` — v1, read-only: feed list, signal detail,
  civic-process reads, `/health/ready`. ~100 concurrent readers. No login,
  no writes.
- `capacity-1000.js` — Etapa 4's full write-capable scenario: login, feed
  browse, signal detail, confirm, propose, and vote, at 100 concurrent
  VUs for 30 minutes plus a 200-VU/5-minute spike. See "The write-capable
  scenario" below.

## Scope of `staging-capacity.js` (read this before extending it)

This script is read-only by design. It does not authenticate, confirm,
propose, or vote. Two reasons:

1. Authenticated write actions would leave synthetic rows in the staging
   database (confirmations, proposals, etc.). This project's staging seed
   (`src/db/run-staging-seed.ts`) has strict preflight guards around
   unexpected row counts specifically to protect real staging activity —
   load-test writes would trip those guards on the next seed run.
2. Simulating real passkey/password auth at load-test scale needs either a
   pool of dedicated load-test accounts or a mocked auth path.

`capacity-1000.js` is that future iteration: it solves both problems with
dedicated, disposable load-test accounts and an extension to the staging
seed guards — see below.

## The write-capable scenario (`capacity-1000.js`)

Etapa 4 of the TOWN deployment plan needs real writes under load: confirm,
propose, and vote all mutate the database and are gated by session auth,
civic-actor/community matching, and (for votes) a single-use ballot token.
None of that can be exercised by a read-only script.

### Why this runs against a dedicated, permanent environment, not shared Staging

Earlier iterations provisioned an ephemeral dataset directly in the shared
Staging Postgres and deleted it afterward. That is no longer possible:
`civic_process_events` / `civic_process_transitions` are unconditionally
append-only from the moment a signal is created
(`drizzle/0041_civic_process_confirmation.sql`, `BEFORE UPDATE OR DELETE`
triggers with no exception), and `civic_process_events.process_id` /
`civic_processes.signal_id` are both `ON DELETE RESTRICT` — so every
signal ever created, and transitively its community, becomes permanently
undeletable the instant it exists. Row-level teardown of load-test data in
a shared database is therefore not viable at all, regardless of how
carefully scoped.

A later iteration tried creating and destroying a temporary Postgres + API
service on every run instead. Two real dispatches of that design failed on
Railway infrastructure races (a missing volume, then a stale deployment
snapshot) before ever reaching the k6 step. The current design targets a
**permanent, dedicated Railway environment named `capacity`**, provisioned
once by hand, whose database schema is reset (dropped and re-migrated)
before each run instead of the services themselves being recreated. See
`.github/workflows/capacity-drill.yml` and
`docs/operations/CAPACITY_DRILL_RUNBOOK.md`.

### Fixed-identity fixtures, not a manifest file

Because the schema reset guarantees the database is empty before every
run, every ID/slug/email/password the drill uses is a **fixed constant**,
not generated per run — see `src/platform/capacity-drill/fixtures.ts`.
This lets the setup phase (running inside `town-api-capacity`) and
`capacity-1000.js` (running on the GitHub Actions runner, with no shared
filesystem) independently compute the same identity without passing a
manifest file between two different machines. `capacity-1000.js` mirrors
`fixtures.ts`'s constants in plain JS at the top of the file; keep the two
in sync by hand if either changes.

`src/platform/run-capacity-setup.ts` (compiled to
`dist/scripts/capacity-setup.js`) resets the `town`/`drizzle` Postgres
schemas (refusing unless `RAILWAY_ENVIRONMENT_NAME` is exactly
`capacity`), runs migrations, seeds the deterministic foundation content,
then provisions two ephemeral-shaped communities (the main confirm/propose
pool) plus a small voting arena (signals already advanced to `voting`,
mirroring the old permanent voting-arena fixture's shape). Every run
starts from a genuinely empty schema, so nothing needs to survive past one
run despite the underlying service being permanent.
`src/platform/run-capacity-verify.ts` (`dist/scripts/capacity-verify.js`)
then checks DB-level integrity (duplicate/cross-community confirmations,
proposals, ballot tokens, that consumed ballot tokens exactly match cast
votes, and a `pg_stat_activity`/`pg_locks` snapshot).

### What the script does

`capacity-1000.js` logs each virtual user into one of the ephemeral pool's
accounts (session cached per VU, like a real returning user), then
repeats: browse the account's own community feed, open a signal, read its
civic-process state, confirm it (idempotent write), and — if that
signal's process has reached `proposals` — submit a proposal (expects
`201` once, `409 CIVIC_PROPOSAL_ALREADY_SUBMITTED` after). A small
fraction of iterations attempt to confirm a signal in the _other_
community as a negative test (must always be `403
CIVIC_PARTICIPATION_NOT_AUTHORIZED`), and a small fraction run a vote
sub-journey against the permanent voting-arena fixture instead: log in as
one of its 40 accounts, read the frozen ballot options, and cast a vote
(expects `201` once, `409 CIVIC_VOTE_ALREADY_CAST` after). With only 40
accounts x 8 signals in the arena, many VUs collide on the same
actor/process pair — deliberately, to prove the single-use ballot token
holds under real concurrent double-vote attempts, not just sequential
ones.

Business-logic rejections (`409` duplicate proposal/vote, `403`
cross-community) are expected outcomes, not failures, so thresholds are
set against custom `unexpected_failure_rate` / `server_error_rate`
metrics rather than k6's built-in `http_req_failed` (which would otherwise
count every deliberate rejection as a failure and make the threshold
meaningless).

No real email is ever sent (load-test accounts are created pre-verified)
and Stripe is never called (load-test accounts are `isOwner: true`).

## Running it

**Never point this at production.** Both scripts refuse to run (throw
before any request is made) unless `BASE_URL` looks like staging — there is
no override flag by design.

`staging-capacity.js`, locally with
[k6 installed](https://grafana.com/docs/k6/latest/set-up/install-k6/):

```bash
k6 run loadtest/staging-capacity.js
```

Or via GitHub Actions, manually: Actions → "Staging capacity test" →
Run workflow. It only runs on `workflow_dispatch` — never automatically on
push or PR — so it never competes with real staging traffic unless someone
deliberately starts it.

`capacity-1000.js` is only ever meant to run against `town-api-capacity`,
the permanent service in the dedicated `capacity` Railway environment — it
points `BASE_URL` at that service's fixed public domain
(`town-api-capacity-capacity.up.railway.app`), which the host allowlist
below already permits. There is no supported way to run it by hand against
shared Staging or production; the fixed-identity fixtures above are only
safe immediately after a schema reset. To run the whole drill: Actions →
"Etapa 4 capacity drill" → Run workflow. That single dispatch resets the
schema, migrates, seeds, provisions the fixtures, serves, runs k6, and
verifies — twice, back to back, and the second run only starts if the
first fully passed.

## Reading the result

k6 prints a summary at the end. For `staging-capacity.js`:

- `http_req_failed` — should be well under 1%. Anything higher means
  staging is dropping requests under this load, not just slowing down.
- `http_req_duration` per endpoint (tagged `community_signals`,
  `signal_detail`, `civic_process`) — the thresholds in the script
  (p95 targets) will make k6 itself exit non-zero if they're breached, so a
  clean exit code is the first signal to check.
- Watch `/health/ready` (`readiness_probe` scenario) stays `200` throughout
  — if it flips to `503` mid-run, the single replica is not keeping up and
  that's the real finding, independent of whatever the feed-read numbers
  say.

A passing run is evidence for "staging survives ~100 concurrent readers,"
nothing more. It is not evidence about production (different region,
currently identical single-replica config — see
`docs/operations/DEPLOYMENT_READINESS_V1.md` §3), and it is not evidence
about write-heavy load (confirmations/proposals/votes) — that's what
`capacity-1000.js` is for.

For `capacity-1000.js`, ignore `http_req_failed` (it counts every
deliberate rejection, like a duplicate vote, as a "failure") and look at
`unexpected_failure_rate` and `server_error_rate` instead, plus
`http_req_duration` split by the `kind:read` / `kind:write` tags. A
passing run does not by itself prove "zero duplicate votes, zero
cross-community access" — that requires the separate DB-level verification
script comparing what the database actually recorded against what the
script attempted.

## Results (`staging-capacity.js`)

**2026-08-10, first real run** ([workflow run #1](https://github.com/michaeltofan/town-api/actions/runs/31431253708)),
ramping 0→100 VUs over 1 minute, holding 100 for 2 minutes, ramping down over
30s (3m30s total), plus a continuous `/health/ready` probe:

| Metric                     | Result                                                   |
| -------------------------- | -------------------------------------------------------- |
| Total requests             | 10,591 (49.66 req/s average)                             |
| Failed requests            | 0 (`http_req_failed` = 0.00%, threshold was `<1%`)       |
| Completed iterations       | 4,594 full browse-feed journeys, 0 interrupted           |
| `community_signals` p95    | 296.64ms (threshold `<800ms`)                            |
| `signal_detail` p95        | 281.24ms (threshold `<500ms`)                            |
| `civic_process` p95        | 272.7ms (threshold `<500ms`)                             |
| `/health/ready` under load | Stayed `200` for the full 3m30s — never flipped to `503` |

All k6 thresholds passed; exit code was clean. Staging's current
single-replica deployment handled ~100 concurrent readers without shedding
requests or degrading readiness. This is evidence for read capacity only —
see the Scope section above for what it does not cover (writes, auth,
production's identically-sized replica count under real user load).

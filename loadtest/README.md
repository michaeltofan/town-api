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

### Data provisioning (run before every k6 invocation)

1. `loadtest/provision.ts` — builds a fully **ephemeral** dataset: two
   dedicated communities, ~23 signals, and a pool of ~250 real
   login-capable accounts (`isOwner: true`, which bypasses the
   membership/payment entitlement gate — no Stripe, no real money). Writes
   `loadtest/.manifest.json`. Every row this creates is deleted by
   `loadtest/teardown.ts` at the end of the run.
2. `loadtest/ensure-voting-arena.ts` — maintains a small **permanent**
   fixture (one community, 8 signals already at the `voting` stage, 40
   voter accounts). Writes `loadtest/.voting-arena-manifest.json`.
   Idempotent and never torn down: `civic_ballot_eligible_actors` is
   append-only (`ON DELETE RESTRICT` cascades all the way up to the
   community), so a signal that reaches `voting` can never be deleted
   again — see the doc comment in `src/db/seeds/loadtest-voting-arena.ts`
   for the full reasoning. `run-staging-seed.ts`'s row-count preflight
   guard excludes this fixture's community by ID so its permanent presence
   never blocks a future foundation-content reseed.

Both scripts require `APP_ENV=staging` and a `DATABASE_URL` pointed at
staging's Postgres (e.g. via `railway run`); both refuse to run otherwise.

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

`capacity-1000.js` needs the provisioning step first, and a manifest path
pointed at each other:

```bash
export APP_ENV=staging
export DATABASE_URL=...   # staging Postgres, e.g. via `railway run`
npx tsx loadtest/provision.ts
npx tsx loadtest/ensure-voting-arena.ts
k6 run --env BASE_URL=https://api-staging.towncivic.org loadtest/capacity-1000.js
npx tsx loadtest/teardown.ts   # deletes only what provision.ts created
```

The orchestrating GitHub Actions workflow that runs this end to end
(provision → k6 → verify → teardown, twice, with CPU/RAM/DB metrics) is
tracked separately — see the Etapa 4 section of the deployment plan for
current status.

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

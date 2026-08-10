# Staging capacity test

`staging-capacity.js` is a [k6](https://k6.io) script that simulates ~100
concurrent people browsing the feed against **staging only**
(`https://api-staging.towncivic.org`). It exists to answer one question
honestly instead of guessing: does the current single-replica staging
deployment stay healthy under a realistic burst of read traffic?

## Scope (read this before extending it)

This is v1 and it is **read-only**: feed list, signal detail, civic-process
reads, and `/health/ready`. It does not authenticate, confirm, propose, or
vote. Two reasons:

1. Authenticated write actions would leave synthetic rows in the staging
   database (confirmations, proposals, etc.). This project's staging seed
   (`src/db/run-staging-seed.ts`) has strict preflight guards around
   unexpected row counts specifically to protect real staging activity —
   load-test writes would trip those guards on the next seed run.
2. Simulating real passkey/password auth at load-test scale needs either a
   pool of dedicated load-test accounts or a mocked auth path, neither of
   which exist yet. Don't fake it by hammering the auth endpoints with
   invalid credentials either — that exercises the rate limiter, not
   capacity.

If a future iteration adds write traffic or authenticated flows, it must
also update the staging seed guards and use dedicated load-test accounts
that are excluded from canonical-count assertions elsewhere in this repo
and in `town-public`'s test suite.

## Running it

**Never point this at production.** The script refuses to run (throws
before any request is made) unless `BASE_URL` looks like staging — there is
no override flag by design.

Locally, with [k6 installed](https://grafana.com/docs/k6/latest/set-up/install-k6/):

```bash
k6 run loadtest/staging-capacity.js
```

Or via GitHub Actions, manually: Actions → "Staging capacity test" →
Run workflow. It only runs on `workflow_dispatch` — never automatically on
push or PR — so it never competes with real staging traffic unless someone
deliberately starts it.

## Reading the result

k6 prints a summary at the end. What to look at:

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
about write-heavy load (confirmations/proposals/votes), which this version
does not exercise.

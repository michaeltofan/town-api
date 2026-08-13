#!/usr/bin/env bash
set -euo pipefail

# Opens a short-lived `railway connect --tunnel-only` SSH tunnel to the
# named Railway Postgres service, exports DATABASE_URL for the duration of
# one command, then always tears the tunnel down -- even if the command
# fails.
#
# This exact tunnel mechanism (railway connect --tunnel-only + a
# registered throwaway SSH key) is proven reliable against an ORDINARY,
# already-existing Railway service: a dedicated diagnostic run confirmed
# it works first try against staging Postgres. It is specifically
# unreliable against a freshly PITR-restored sibling service (see
# docs/operations/RESTORE_DRILL_RUNBOOK.md) -- not relevant here, since
# this script only ever targets the real, long-lived staging Postgres.
#
# Required env: TARGET_SERVICE, RAILWAY_PROJECT_ID, RAILWAY_ENVIRONMENT,
# RAILWAY_API_TOKEN. Opens a fresh tunnel per invocation rather than
# holding one open for the whole job, so the risk window per connection
# stays small and each of provision/ensure-voting-arena/verify/teardown
# gets an independent retry budget.
#
# Usage: with-staging-tunnel.sh -- <command> [args...]

if [[ "${1:-}" != "--" ]]; then
  echo "Usage: $0 -- <command> [args...]" >&2
  exit 2
fi
shift

: "${TARGET_SERVICE:?TARGET_SERVICE is required}"
: "${RAILWAY_PROJECT_ID:?RAILWAY_PROJECT_ID is required}"
: "${RAILWAY_ENVIRONMENT:?RAILWAY_ENVIRONMENT is required}"
: "${RAILWAY_API_TOKEN:?RAILWAY_API_TOKEN is required}"

TUNNEL_OUT="$(mktemp)"
TUNNEL_PID=""

cleanup() {
  if [[ -n "$TUNNEL_PID" ]]; then
    pkill -P "$TUNNEL_PID" 2>/dev/null || true
    kill "$TUNNEL_PID" 2>/dev/null || true
  fi
  rm -f "$TUNNEL_OUT"
}
trap cleanup EXIT
# A bare `trap cleanup EXIT` does not reliably fire on an external TERM/INT
# (e.g. a GitHub Actions job timeout or manual cancellation) unless the
# signal itself triggers a normal exit -- so trap those explicitly too,
# otherwise a killed workflow step can leak the tunnel's SSH child process.
trap 'exit 143' TERM
trap 'exit 130' INT

CANDIDATE_URL=""
for attempt in 1 2 3 4 5 6; do
  echo "with-staging-tunnel: attempt ${attempt}: opening tunnel to ${TARGET_SERVICE}..." >&2
  : > "$TUNNEL_OUT"
  railway connect "$TARGET_SERVICE" \
    --project "$RAILWAY_PROJECT_ID" \
    --environment "$RAILWAY_ENVIRONMENT" \
    --tunnel-only > "$TUNNEL_OUT" 2>&1 &
  TUNNEL_PID=$!

  for _ in $(seq 1 15); do
    if grep -qE 'postgres(ql)?://' "$TUNNEL_OUT" 2>/dev/null; then
      break
    fi
    sleep 1
  done

  if grep -qE 'postgres(ql)?://' "$TUNNEL_OUT" 2>/dev/null; then
    CANDIDATE_URL=$(grep -oE 'postgres(ql)?://[^[:space:]]+' "$TUNNEL_OUT" | head -1)
    echo "::add-mask::${CANDIDATE_URL}"
    if PGCONNECT_TIMEOUT=5 psql "$CANDIDATE_URL" -v ON_ERROR_STOP=1 -tAc 'SELECT 1' > /dev/null 2>&1; then
      echo "with-staging-tunnel: tunnel is up and Postgres answered." >&2
      break
    fi
    echo "with-staging-tunnel: tunnel opened but Postgres did not answer yet." >&2
    CANDIDATE_URL=""
  else
    sed -E 's#postgres(ql)?://[^[:space:]]+#[redacted]#g' "$TUNNEL_OUT" | tail -5 >&2
  fi

  pkill -P "$TUNNEL_PID" 2>/dev/null || true
  kill "$TUNNEL_PID" 2>/dev/null || true
  TUNNEL_PID=""
  sleep 5
done

if [[ -z "$CANDIDATE_URL" ]]; then
  echo "::error::with-staging-tunnel: could not open a working tunnel to ${TARGET_SERVICE} after 6 attempts." >&2
  exit 1
fi

export DATABASE_URL="$CANDIDATE_URL"
"$@"

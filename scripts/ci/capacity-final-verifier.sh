#!/usr/bin/env bash
set -euo pipefail

OUTPUT_FILE="${1:-capacity-final-verify.txt}"
DEPLOYMENT_ID="${2:-}"
CYCLE="${3:-}"
NOT_BEFORE="${4:-}"

if [[ -z "$DEPLOYMENT_ID" ]]; then
  echo "::error::Current server deployment id is required"
  exit 1
fi
if [[ "$CYCLE" != "1" && "$CYCLE" != "2" ]]; then
  echo "::error::Capacity cycle must be exactly 1 or 2"
  exit 1
fi
if [[ -z "$NOT_BEFORE" ]]; then
  echo "::error::The k6 completion timestamp is required"
  exit 1
fi

RESULT_MARKER=""
for attempt in $(seq 1 24); do
  LOGS_RESPONSE=$(railway api \
    'query($deploymentId: String!, $limit: Int) { deploymentLogs(deploymentId: $deploymentId, limit: $limit) { message severity attributes { key value } } }' \
    --variables "{\"deploymentId\":\"${DEPLOYMENT_ID}\",\"limit\":500}" \
    --allow-errors \
    --compact)
  RESULT_MARKER=$(echo "$LOGS_RESPONSE" | node -e "
    const d = JSON.parse(require('fs').readFileSync(0, 'utf8'));
    if (d.errors) throw new Error('deploymentLogs GraphQL errors: ' + JSON.stringify(d.errors));
    const expectedCycle = Number(process.argv[1]);
    const notBefore = Date.parse(process.argv[2]);
    if (!Number.isFinite(notBefore)) throw new Error('invalid not-before timestamp');
    let match;
    for (const log of (d.data?.deploymentLogs ?? [])) {
      const candidates = [];
      for (const attribute of (log.attributes || [])) {
        if (attribute.key !== 'capacityVerifyResult') continue;
        try { candidates.push(JSON.parse(attribute.value)); } catch {}
      }
      try {
        const parsed = JSON.parse(log.message);
        if (parsed?.capacityVerifyResult) candidates.push(parsed.capacityVerifyResult);
      } catch {}
      for (const marker of candidates) {
        const observedAt = Date.parse(marker?.observedAt);
        if (
          marker?.cycle === expectedCycle &&
          Number.isFinite(observedAt) &&
          observedAt >= notBefore &&
          (!match || observedAt > Date.parse(match.observedAt))
        ) {
          match = marker;
        }
      }
    }
    if (match) process.stdout.write(JSON.stringify(match));
  " "$CYCLE" "$NOT_BEFORE")
  [[ -n "$RESULT_MARKER" ]] && break
  echo "post-load capacityVerifyResult pending for cycle=${CYCLE} (${attempt}/24)"
  sleep 5
done

if [[ -z "$RESULT_MARKER" ]]; then
  echo "::error::Post-load capacityVerifyResult was not available for cycle=${CYCLE}"
  exit 1
fi

echo "$RESULT_MARKER" | node -e "
  const result = JSON.parse(require('fs').readFileSync(0, 'utf8'));
  console.log('outcome=' + result.outcome);
  console.log('cycle=' + result.cycle);
  console.log('observed_at=' + result.observedAt);
  console.log('checks=' + JSON.stringify(result.checks ?? []));
  console.log('counts=' + JSON.stringify(result.counts ?? {}));
" > "$OUTPUT_FILE"
cat "$OUTPUT_FILE"
OUTCOME=$(grep '^outcome=' "$OUTPUT_FILE" | cut -d= -f2-)
if [[ "$OUTCOME" != "passed" ]]; then
  exit 1
fi

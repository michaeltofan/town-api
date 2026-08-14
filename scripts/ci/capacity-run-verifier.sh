#!/usr/bin/env bash
set -euo pipefail

: "${API_SERVICE_ID:?API_SERVICE_ID is required}"
: "${RAILWAY_ENVIRONMENT_ID:?RAILWAY_ENVIRONMENT_ID is required}"

OUTPUT_FILE="${1:-capacity-verify.txt}"

UPDATE_INPUT='{"serviceId":"'"${API_SERVICE_ID}"'","environmentId":"'"${RAILWAY_ENVIRONMENT_ID}"'","input":{"startCommand":"node dist/scripts/capacity-verify.js","restartPolicyType":"NEVER"}}'
UPDATE_RESPONSE=$(railway api \
  'mutation($serviceId: String!, $environmentId: String, $input: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input) }' \
  --variables "$UPDATE_INPUT" --allow-errors --compact)
echo "$UPDATE_RESPONSE" | node -e "
  const d = JSON.parse(require('fs').readFileSync(0, 'utf8'));
  if (d.errors) throw new Error('serviceInstanceUpdate GraphQL errors: ' + JSON.stringify(d.errors));
  if (d.data?.serviceInstanceUpdate !== true) throw new Error('unexpected serviceInstanceUpdate response');
"

DEPLOY_INPUT='{"environmentId":"'"${RAILWAY_ENVIRONMENT_ID}"'","serviceId":"'"${API_SERVICE_ID}"'"}'
DEPLOY_RESPONSE=$(railway api \
  'mutation($environmentId: String!, $serviceId: String!) { serviceInstanceDeployV2(environmentId: $environmentId, serviceId: $serviceId) }' \
  --variables "$DEPLOY_INPUT" --allow-errors --compact)
DEPLOYMENT_ID=$(echo "$DEPLOY_RESPONSE" | node -e "
  const d = JSON.parse(require('fs').readFileSync(0, 'utf8'));
  if (d.errors) throw new Error('serviceInstanceDeployV2 GraphQL errors: ' + JSON.stringify(d.errors));
  const id = d.data?.serviceInstanceDeployV2;
  if (!id) throw new Error('unexpected serviceInstanceDeployV2 response');
  console.log(id);
")

STATUS=""
for _tick in $(seq 1 240); do
  STATUS_RESPONSE=$(railway api \
    'query($id: String!) { deployment(id: $id) { status } }' \
    --variables "{\"id\":\"${DEPLOYMENT_ID}\"}" --allow-errors --compact)
  STATUS=$(echo "$STATUS_RESPONSE" | node -e "
    const d = JSON.parse(require('fs').readFileSync(0, 'utf8'));
    if (d.errors) throw new Error('deployment query GraphQL errors: ' + JSON.stringify(d.errors));
    console.log(d.data?.deployment?.status ?? 'UNKNOWN');
  ")
  case "$STATUS" in SUCCESS|FAILED|CRASHED|REMOVED) break ;; esac
  sleep 5
done

RESULT_MARKER=""
for attempt in $(seq 1 12); do
  LOGS_RESPONSE=$(railway api \
    'query($deploymentId: String!, $limit: Int) { deploymentLogs(deploymentId: $deploymentId, limit: $limit) { message severity attributes { key value } } }' \
    --variables "{\"deploymentId\":\"${DEPLOYMENT_ID}\",\"limit\":500}" --allow-errors --compact)
  RESULT_MARKER=$(echo "$LOGS_RESPONSE" | node -e "
    const d = JSON.parse(require('fs').readFileSync(0, 'utf8'));
    if (d.errors) throw new Error('deploymentLogs GraphQL errors: ' + JSON.stringify(d.errors));
    for (const log of (d.data?.deploymentLogs ?? [])) {
      for (const attribute of (log.attributes || [])) {
        if (attribute.key === 'capacityVerifyResult') process.stdout.write(attribute.value);
      }
    }
  ")
  [[ -n "$RESULT_MARKER" ]] && break
  echo "capacityVerifyResult marker pending (${attempt}/12)"
  sleep 5
done

if [[ -z "$RESULT_MARKER" ]]; then
  echo "::error::capacityVerifyResult marker was not available"
  exit 1
fi

echo "$RESULT_MARKER" | node -e "
  const result = JSON.parse(require('fs').readFileSync(0, 'utf8'));
  console.log('outcome=' + result.outcome);
  console.log('checks=' + JSON.stringify(result.checks ?? []));
  console.log('counts=' + JSON.stringify(result.counts ?? {}));
" > "$OUTPUT_FILE"
cat "$OUTPUT_FILE"
OUTCOME=$(grep '^outcome=' "$OUTPUT_FILE" | cut -d= -f2-)
if [[ "$STATUS" != "SUCCESS" || "$OUTCOME" != "passed" ]]; then
  exit 1
fi

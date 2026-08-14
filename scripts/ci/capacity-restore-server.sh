#!/usr/bin/env bash
set -euo pipefail

: "${API_SERVICE_ID:?API_SERVICE_ID is required}"
: "${RAILWAY_ENVIRONMENT_ID:?RAILWAY_ENVIRONMENT_ID is required}"
: "${BASE_URL:?BASE_URL is required}"

UPDATE_INPUT='{"serviceId":"'"${API_SERVICE_ID}"'","environmentId":"'"${RAILWAY_ENVIRONMENT_ID}"'","input":{"startCommand":"node dist/server.js","restartPolicyType":"ON_FAILURE"}}'
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
for _tick in $(seq 1 120); do
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
if [[ "$STATUS" != "SUCCESS" ]]; then
  echo "::error::Capacity API restore deployment failed (status=${STATUS})"
  exit 1
fi

for _attempt in $(seq 1 60); do
  BODY=$(curl -fsS "${BASE_URL}/health/ready" 2>/dev/null || true)
  if [[ "$BODY" == *'"status":"ready"'* ]]; then
    echo "Capacity API restored and ready."
    exit 0
  fi
  sleep 5
done
echo "::error::Capacity API did not become ready after restore"
exit 1

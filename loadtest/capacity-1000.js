import http from 'k6/http';
import { check, sleep } from 'k6';
import crypto from 'k6/crypto';
import { Counter, Rate } from 'k6/metrics';
import exec from 'k6/execution';

/**
 * TOWN Etapa 4 capacity test — isolated, temporary environment only, real
 * writes.
 *
 * Full write-capable version of `staging-capacity.js`: login, feed browse,
 * signal detail, confirm, propose, and vote, driven by the fixed-identity
 * capacity-drill fixtures that `src/platform/run-capacity-setup.ts`
 * provisions inside a brand-new, temporary Postgres before this script
 * runs. Never touches real accounts, never sends real email (all
 * load-test accounts are created pre-verified), and never calls Stripe
 * (all load-test accounts are `isOwner: true`, which bypasses the
 * membership/payment entitlement gate -- see the doc comments in
 * src/platform/capacity-drill/provisioning.ts).
 *
 * The account/signal identity below is generated, not read from a
 * manifest file: the setup phase (a throwaway Railway service) and this
 * k6 phase (the GitHub Actions runner) have no shared filesystem, so both
 * sides independently compute the same fixed IDs from
 * src/platform/capacity-drill/fixtures.ts. Keep the two in sync by hand
 * if either changes.
 *
 * SAFETY: same host allowlist as staging-capacity.js, duplicated
 * deliberately rather than shared -- this is the one guard in this whole
 * directory that must never silently fail to apply. There is no override
 * flag. If you need to test something else, change BASE_URL deliberately
 * and re-read this comment first.
 */

const BASE_URL = __ENV.BASE_URL || 'https://api-staging.towncivic.org';

const ALLOWED_HOST_PATTERNS = [
  /^https:\/\/api-staging\.towncivic\.org$/,
  /^https:\/\/[a-z0-9-]+\.up\.railway\.app$/,
];

if (!ALLOWED_HOST_PATTERNS.some((pattern) => pattern.test(BASE_URL))) {
  throw new Error(
    `Refusing to run: BASE_URL "${BASE_URL}" does not look like a staging host. ` +
      'This load test must never point at api.towncivic.org (production). ' +
      'Allowed: https://api-staging.towncivic.org or a *.up.railway.app Railway domain.',
  );
}

if (BASE_URL.includes('api.towncivic.org')) {
  throw new Error('Refusing to run: BASE_URL resolves to production. Aborting.');
}

// Mirrors src/platform/capacity-drill/fixtures.ts -- see the file header
// comment above for why this is generated here rather than read from a
// manifest file.
const CAPACITY_DRILL_PASSWORD = 'CapacityDrill-2026-Isolated!';
const CAPACITY_DRILL_AUTH_SECRET = __ENV.CAPACITY_DRILL_AUTH_SECRET;
const CAPACITY_DRILL_CYCLE = __ENV.CAPACITY_DRILL_CYCLE || '1';

if (!CAPACITY_DRILL_AUTH_SECRET || CAPACITY_DRILL_AUTH_SECRET.length < 32) {
  throw new Error('CAPACITY_DRILL_AUTH_SECRET must contain at least 32 characters');
}
if (!['1', '2'].includes(CAPACITY_DRILL_CYCLE)) {
  throw new Error('CAPACITY_DRILL_CYCLE must be exactly 1 or 2');
}

const MAIN_SIGNAL_COUNT_A = 20;
const MAIN_SIGNAL_COUNT_B = 3;
const ARENA_SIGNAL_COUNT = 8;
const ACCOUNT_COUNT_A = 225;
const ACCOUNT_COUNT_B = 25;
const ARENA_ACCOUNT_COUNT = 40;

function fixedId(group, index) {
  const cycleGroup = `${CAPACITY_DRILL_CYCLE === '1' ? 'c' : 'd'}${group.slice(1)}`;
  return `00000000-0000-4000-${cycleGroup}-${index.toString().padStart(12, '0')}`;
}

function fixedIds(group, count) {
  return Array.from({ length: count }, (_unused, i) => fixedId(group, i + 1));
}

function fixedAccounts(accountGroup, actorGroup, emailPrefix, count) {
  const cycleSuffix = CAPACITY_DRILL_CYCLE === '1' ? '' : '-cycle-2';
  return Array.from({ length: count }, (_unused, i) => ({
    accountId: fixedId(accountGroup, i + 1),
    actorId: fixedId(actorGroup, i + 1),
    email: `${emailPrefix}${cycleSuffix}-${String(i + 1)}@loadtest.internal`,
  }));
}

function capacitySessionToken(accountId) {
  return crypto.hmac(
    'sha256',
    CAPACITY_DRILL_AUTH_SECRET,
    `town.capacity_drill_session.v1\0${accountId}`,
    'hex',
  );
}

const cycleSuffix = CAPACITY_DRILL_CYCLE === '1' ? '' : '-cycle-2';
const communityA = { id: fixedId('c001', 1), slug: `capacity-drill-a${cycleSuffix}` };
const communityB = { id: fixedId('c002', 1), slug: `capacity-drill-b${cycleSuffix}` };

const signalsMain = fixedIds('c101', MAIN_SIGNAL_COUNT_A);
const signalsSecondary = fixedIds('c102', MAIN_SIGNAL_COUNT_B);
const arenaSignals = fixedIds('c103', ARENA_SIGNAL_COUNT);

const mainAccounts = fixedAccounts('c201', 'c301', 'capacity-a', ACCOUNT_COUNT_A)
  .map((a) => ({
    ...a,
    password: CAPACITY_DRILL_PASSWORD,
    communityId: communityA.id,
  }))
  .concat(
    fixedAccounts('c202', 'c302', 'capacity-b', ACCOUNT_COUNT_B).map((a) => ({
      ...a,
      password: CAPACITY_DRILL_PASSWORD,
      communityId: communityB.id,
    })),
  );

const arenaAccounts = fixedAccounts('c203', 'c303', 'capacity-arena', ARENA_ACCOUNT_COUNT).map(
  (a) => ({ ...a, password: CAPACITY_DRILL_PASSWORD }),
);

const unexpectedFailureRate = new Rate('unexpected_failure_rate');
const serverErrorRate = new Rate('server_error_rate');
const writeOracleFailureRate = new Rate('write_oracle_failure_rate');
const status2xx = new Counter('http_status_2xx');
const status401 = new Counter('http_status_401');
const status403 = new Counter('http_status_403');
const status409 = new Counter('http_status_409');
const status429 = new Counter('http_status_429');
const statusOther4xx = new Counter('http_status_other_4xx');
const status5xx = new Counter('http_status_5xx');
const statusOther = new Counter('http_status_other');

const endpointFailureRates = Object.fromEntries(
  [
    'login',
    'community_signals',
    'signal_detail',
    'civic_process',
    'confirm',
    'propose',
    'cross_community_confirm',
    'voting_read',
    'vote',
    'health_ready',
    'synthetic_readback',
    'proposal_readback',
    'vote_readback',
  ].map((name) => [name, new Rate(`unexpected_failure_${name}`)]),
);

const EXPECT_200 = http.expectedStatuses(200);
const EXPECT_201 = http.expectedStatuses(201);
const EXPECT_201_OR_409 = http.expectedStatuses(201, 409);
const EXPECT_403 = http.expectedStatuses(403);
const loggedFailures = {};

const thresholds = {
  unexpected_failure_rate: ['rate<0.01'],
  server_error_rate: ['rate<0.005'],
  write_oracle_failure_rate: ['rate==0'],
};

const readEndpoints = [
  'community_signals',
  'signal_detail',
  'civic_process',
  'voting_read',
  'health_ready',
  'synthetic_readback',
  'proposal_readback',
  'vote_readback',
];
const writeEndpoints = ['login', 'confirm', 'propose', 'cross_community_confirm', 'vote'];
const endpointLatencyThresholds = Object.fromEntries(
  readEndpoints
    .map((endpoint) => [`http_req_duration{endpoint:${endpoint}}`, ['p(95)<500', 'p(99)<1500']])
    .concat(
      writeEndpoints.map((endpoint) => [
        `http_req_duration{endpoint:${endpoint}}`,
        ['p(95)<800', 'p(99)<1500'],
      ]),
    ),
);

const capacityOptions = {
  scenarios: {
    // ~1,000-user-scale steady load: 100 concurrent virtual users for 30
    // minutes, covering login/feed/detail/confirm/propose/vote.
    steady: {
      executor: 'ramping-vus',
      exec: 'userJourney',
      startVUs: 0,
      stages: [
        { duration: '1m', target: 100 },
        { duration: '30m', target: 100 },
        { duration: '30s', target: 0 },
      ],
    },
    // Spike: 200 concurrent virtual users for 5 minutes, right after the
    // steady phase finishes ramping down.
    spike: {
      executor: 'ramping-vus',
      exec: 'userJourney',
      startVUs: 0,
      startTime: '31m30s',
      stages: [
        { duration: '20s', target: 200 },
        { duration: '5m', target: 200 },
        { duration: '20s', target: 0 },
      ],
    },
    readiness_probe: {
      executor: 'constant-vus',
      exec: 'probeReadiness',
      vus: 1,
      duration: '37m10s',
    },
    // The API deliberately limits one source IP to 30 password attempts per
    // 30 minutes. A single GitHub runner cannot model many client IPs, so this
    // lane exercises real login at a safe cadence while the main lanes reuse
    // the pre-provisioned mobile sessions a returning user would already hold.
    login_lane: {
      executor: 'constant-arrival-rate',
      exec: 'loginJourney',
      rate: 1,
      timeUnit: '2m',
      duration: '37m10s',
      preAllocatedVUs: 1,
      maxVUs: 2,
    },
  },
  summaryTrendStats: ['min', 'med', 'avg', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],
  thresholds: {
    ...thresholds,
    'http_req_duration{kind:read}': ['p(95)<500'],
    'http_req_duration{kind:write}': ['p(95)<800'],
    http_req_duration: ['p(99)<1500'],
    ...endpointLatencyThresholds,
  },
};

const preflightMode = __ENV.CAPACITY_PREFLIGHT_MODE || 'real';
if (!['real', 'synthetic'].includes(preflightMode)) {
  throw new Error(`Unsupported CAPACITY_PREFLIGHT_MODE "${preflightMode}"`);
}

const preflightOptions = {
  scenarios: {
    preflight: {
      executor: 'shared-iterations',
      exec: preflightMode === 'synthetic' ? 'syntheticPreflight' : 'realAuthPreflight',
      vus: 1,
      iterations: 1,
      maxDuration: '2m',
    },
  },
  summaryTrendStats: ['min', 'med', 'avg', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],
  thresholds,
};

export const options = __ENV.CAPACITY_PREFLIGHT === 'true' ? preflightOptions : capacityOptions;

function randomItem(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function randomSleep(minSeconds, maxSeconds) {
  sleep(Math.random() * (maxSeconds - minSeconds) + minSeconds);
}

/**
 * Records whether a response matched one of its expected outcomes (business
 * rejections like "already voted" or "already submitted" count as expected,
 * not failures) and separately tracks real 5xx responses. Thresholds in
 * `options` are set against these custom metrics, not k6's built-in
 * `http_req_failed`, precisely because this scenario deliberately triggers
 * expected non-2xx outcomes (duplicate votes/proposals, cross-community
 * denials) that must not count against the failure-rate budget.
 */
function safeApplicationCode(res) {
  try {
    const parsed = JSON.parse(res.body);
    const value = parsed?.error?.code ?? parsed?.code ?? parsed?.errorCode ?? null;
    return typeof value === 'string' ? value.slice(0, 80) : null;
  } catch {
    return null;
  }
}

function record(res, expectedStatuses, label) {
  const ok = expectedStatuses.includes(res.status);
  unexpectedFailureRate.add(!ok);
  serverErrorRate.add(res.status >= 500);
  endpointFailureRates[label]?.add(!ok);

  if (res.status >= 200 && res.status < 300) status2xx.add(1);
  else if (res.status === 401) status401.add(1);
  else if (res.status === 403) status403.add(1);
  else if (res.status === 409) status409.add(1);
  else if (res.status === 429) status429.add(1);
  else if (res.status >= 400 && res.status < 500) statusOther4xx.add(1);
  else if (res.status >= 500) status5xx.add(1);
  else statusOther.add(1);

  check(res, { [`${label} status is expected`]: () => ok });

  // One safe diagnostic per endpoint, only from VU 1. Never logs tokens,
  // request bodies, response bodies, emails, or identifiers.
  if (!ok && __VU === 1 && !loggedFailures[label]) {
    loggedFailures[label] = true;
    console.error(
      JSON.stringify({
        capacityDiagnostic: {
          endpoint: label,
          status: res.status,
          applicationCode: safeApplicationCode(res),
        },
      }),
    );
  }
  return ok;
}

function recordWriteOracle(label, passed) {
  writeOracleFailureRate.add(!passed);
  if (!passed) {
    unexpectedFailureRate.add(true);
    endpointFailureRates[label]?.add(true);
  }
  check(passed, { [`${label} persisted effect is visible`]: (value) => value === true });
  return passed;
}

function responseData(res) {
  try {
    return JSON.parse(res.body)?.data ?? null;
  } catch {
    return null;
  }
}

function login(email, password) {
  const res = http.post(
    `${BASE_URL}/v1/authentication/password`,
    JSON.stringify({ email, password, clientType: 'mobile' }),
    {
      headers: { 'Content-Type': 'application/json' },
      tags: { endpoint: 'login', kind: 'write' },
      responseCallback: EXPECT_200,
    },
  );
  if (!record(res, [200], 'login')) return null;
  try {
    return JSON.parse(res.body)?.data?.sessionToken ?? null;
  } catch {
    return null;
  }
}

function authedGet(token, path, endpoint) {
  return http.get(`${BASE_URL}${path}`, {
    headers: { Authorization: `Session ${token}` },
    tags: { endpoint, kind: 'read' },
    responseCallback: EXPECT_200,
  });
}

function authedWrite(method, token, path, body, endpoint, responseCallback) {
  const fn = method === 'PUT' ? http.put : http.post;
  return fn(`${BASE_URL}${path}`, JSON.stringify(body), {
    headers: { Authorization: `Session ${token}`, 'Content-Type': 'application/json' },
    tags: { endpoint, kind: 'write' },
    responseCallback,
  });
}

// Per-VU state: k6 gives every VU its own isolated JS runtime, so this is
// shared across iterations of the same VU (a persistent logged-in session,
// same as a real returning user) but never across VUs.
let cachedSession = null;
let cachedAccount = null;

export function userJourney() {
  if (!cachedSession) {
    const account = mainAccounts[(__VU - 1) % mainAccounts.length];
    cachedSession = capacitySessionToken(account.accountId);
    cachedAccount = account;
  }

  const isCommunityA = cachedAccount.communityId === communityA.id;
  const ownSlug = isCommunityA ? communityA.slug : communityB.slug;
  const ownFallbackSignals = isCommunityA ? signalsMain : signalsSecondary;
  const otherSignals = isCommunityA ? signalsSecondary : signalsMain;

  const feedRes = http.get(`${BASE_URL}/v1/communities/${ownSlug}/signals`, {
    tags: { endpoint: 'community_signals', kind: 'read' },
  });
  record(feedRes, [200], 'community_signals');
  randomSleep(0.3, 1);

  let signalIds = ownFallbackSignals;
  try {
    const body = JSON.parse(feedRes.body);
    const ids = (body?.data?.signals ?? []).map((s) => s.id);
    if (ids.length > 0) signalIds = ids;
  } catch {
    // Non-JSON/unexpected shape already counted as a failed check above.
  }
  if (signalIds.length === 0) {
    randomSleep(0.5, 1.5);
    return;
  }
  const signalId = randomItem(signalIds);

  const detailRes = authedGet(cachedSession, `/v1/signals/${signalId}`, 'signal_detail');
  record(detailRes, [200], 'signal_detail');
  randomSleep(0.3, 1);

  const processRes = authedGet(
    cachedSession,
    `/v1/signals/${signalId}/civic-process`,
    'civic_process',
  );
  record(processRes, [200], 'civic_process');
  let currentStage = null;
  try {
    currentStage = JSON.parse(processRes.body)?.data?.currentStage ?? null;
  } catch {
    // Already counted above.
  }
  randomSleep(0.3, 1);

  // Confirm: idempotent, always succeeds for an own-community participant.
  const confirmRes = authedWrite(
    'PUT',
    cachedSession,
    `/v1/signals/${signalId}/confirmation`,
    {},
    'confirm',
    EXPECT_200,
  );
  if (record(confirmRes, [200], 'confirm')) {
    recordWriteOracle('confirm', responseData(confirmRes)?.confirmed === true);
  }

  // Propose: only possible once the process is in 'proposals', and only
  // once per actor per process -- expect 201 the first time an actor's
  // random signal lands on 'proposals', 409 every time after.
  if (currentStage === 'proposals' && Math.random() < 0.4) {
    const proposeRes = authedWrite(
      'POST',
      cachedSession,
      `/v1/signals/${signalId}/civic-process/proposals`,
      {
        title: `Load test proposal ${cachedAccount.actorId.slice(0, 8)}`,
        body: 'Synthetic proposal submitted by the Etapa 4 capacity test.',
        expectedOutcome: 'Synthetic load-test outcome, not a real civic proposal.',
      },
      'propose',
      EXPECT_201_OR_409,
    );
    if (record(proposeRes, [201, 409], 'propose') && proposeRes.status === 201) {
      const proposalId = responseData(proposeRes)?.id;
      const readbackRes = authedGet(
        cachedSession,
        `/v1/signals/${signalId}/civic-process/proposals`,
        'proposal_readback',
      );
      const readbackOk = record(readbackRes, [200], 'proposal_readback');
      const proposals = responseData(readbackRes)?.proposals ?? [];
      recordWriteOracle(
        'proposal_readback',
        readbackOk &&
          typeof proposalId === 'string' &&
          proposals.some((proposal) => proposal?.id === proposalId && proposal?.isMine === true),
      );
    }
  }

  // Cross-community negative test: confirming a signal in the OTHER
  // community must always be denied. Low probability so it stays a small
  // fraction of traffic, not the dominant journey.
  if (otherSignals.length > 0 && Math.random() < 0.05) {
    const otherSignalId = randomItem(otherSignals);
    const crossRes = authedWrite(
      'PUT',
      cachedSession,
      `/v1/signals/${otherSignalId}/confirmation`,
      {},
      'cross_community_confirm',
      EXPECT_403,
    );
    record(crossRes, [403], 'cross_community_confirm');
  }

  randomSleep(0.5, 2);

  // Vote sub-journey: uses the separate permanent voting-arena fixture
  // (dedicated accounts/signals already at 'voting'), not the ephemeral
  // pool. Many VUs picking randomly from only 40 accounts x 8 signals
  // guarantees real concurrent double-vote attempts against the same
  // actor/process pair -- the point of this sub-journey is proving the
  // single-use ballot token holds under that concurrency, not maximizing
  // successful votes.
  if (Math.random() < 0.15) {
    voteJourney();
  }
}

export function loginJourney() {
  const iteration = exec.scenario.iterationInTest;
  const account = mainAccounts[(iteration + 20) % mainAccounts.length];
  const token = login(account.email, account.password);
  if (!token) return;
  const signalId = account.communityId === communityA.id ? signalsMain[2] : signalsSecondary[0];
  const detailRes = authedGet(token, `/v1/signals/${signalId}`, 'signal_detail');
  record(detailRes, [200], 'signal_detail');
}

function voteJourney() {
  const account = arenaAccounts[(__VU - 1) % arenaAccounts.length];
  const token = capacitySessionToken(account.accountId);

  const signalId = randomItem(arenaSignals);
  const votingRes = authedGet(token, `/v1/signals/${signalId}/civic-process/voting`, 'voting_read');
  record(votingRes, [200], 'voting_read');

  let options = [];
  try {
    options = JSON.parse(votingRes.body)?.data?.options ?? [];
  } catch {
    // Already counted above.
  }
  if (options.length === 0) return;

  const proposalId = randomItem(options).proposalId;
  const voteRes = authedWrite(
    'POST',
    token,
    `/v1/signals/${signalId}/civic-process/voting/vote`,
    { proposalId },
    'vote',
    EXPECT_201_OR_409,
  );
  // 201 the first time this actor votes on this process; 409
  // (already-voted) every subsequent concurrent/repeat attempt.
  if (record(voteRes, [201, 409], 'vote') && voteRes.status === 201) {
    const readbackRes = authedGet(
      token,
      `/v1/signals/${signalId}/civic-process/voting`,
      'vote_readback',
    );
    const readbackOk = record(readbackRes, [200], 'vote_readback');
    recordWriteOracle('vote_readback', readbackOk && responseData(readbackRes)?.hasVoted === true);
  }
}

/**
 * Short fail-fast gate run before either long capacity cycle. Password login
 * remains real here (two requests, safely below the public rate limit); the
 * long load uses capacity-only pre-provisioned sessions above.
 */
export function realAuthPreflight() {
  const mainAccount = mainAccounts[4];
  const mainToken = login(mainAccount.email, mainAccount.password);
  if (!mainToken) return;

  const signalId = signalsMain[0];
  const confirmRes = authedWrite(
    'PUT',
    mainToken,
    `/v1/signals/${signalId}/confirmation`,
    {},
    'preflight_confirm',
    EXPECT_200,
  );
  if (!record(confirmRes, [200], 'preflight_confirm')) return;

  const proposalRes = authedWrite(
    'POST',
    mainToken,
    `/v1/signals/${signalId}/civic-process/proposals`,
    {
      title: 'Capacity drill preflight proposal',
      body: 'Synthetic proposal proving the capacity environment write path.',
      expectedOutcome: 'Preflight write is present in the isolated capacity database.',
    },
    'preflight_propose',
    EXPECT_201,
  );
  if (!record(proposalRes, [201], 'preflight_propose')) return;

  const arenaAccount = arenaAccounts[5];
  const arenaToken = login(arenaAccount.email, arenaAccount.password);
  if (!arenaToken) return;
  const arenaSignalId = arenaSignals[0];
  const votingRes = authedGet(
    arenaToken,
    `/v1/signals/${arenaSignalId}/civic-process/voting`,
    'preflight_voting_read',
  );
  if (!record(votingRes, [200], 'preflight_voting_read')) return;

  let options = [];
  try {
    options = JSON.parse(votingRes.body)?.data?.options ?? [];
  } catch {
    unexpectedFailureRate.add(true);
    return;
  }
  if (options.length === 0) {
    unexpectedFailureRate.add(true);
    return;
  }

  const voteRes = authedWrite(
    'POST',
    arenaToken,
    `/v1/signals/${arenaSignalId}/civic-process/voting/vote`,
    { proposalId: options[0].proposalId },
    'preflight_vote',
    EXPECT_201,
  );
  record(voteRes, [201], 'preflight_vote');
}

/**
 * Final fail-fast gate. This uses exactly the deterministic token derivation,
 * Authorization transport, HTTP helpers, and expected-status callbacks used
 * by the long load. It runs after the workflow's final server deployment and
 * no deployment is allowed between this gate and the long cycle.
 */
export function syntheticPreflight() {
  const mainAccount = mainAccounts[5];
  const mainToken = capacitySessionToken(mainAccount.accountId);
  const signalId = signalsMain[1];

  const feedRes = http.get(`${BASE_URL}/v1/communities/${communityA.slug}/signals`, {
    tags: { endpoint: 'community_signals', kind: 'read' },
    responseCallback: EXPECT_200,
  });
  if (!record(feedRes, [200], 'community_signals')) return;

  const detailRes = authedGet(mainToken, `/v1/signals/${signalId}`, 'signal_detail');
  if (!record(detailRes, [200], 'signal_detail')) return;

  const confirmRes = authedWrite(
    'PUT',
    mainToken,
    `/v1/signals/${signalId}/confirmation`,
    {},
    'confirm',
    EXPECT_200,
  );
  if (!record(confirmRes, [200], 'confirm')) return;

  const crossRes = authedWrite(
    'PUT',
    mainToken,
    `/v1/signals/${signalsSecondary[0]}/confirmation`,
    {},
    'cross_community_confirm',
    EXPECT_403,
  );
  if (!record(crossRes, [403], 'cross_community_confirm')) return;

  const proposalRes = authedWrite(
    'POST',
    mainToken,
    `/v1/signals/${signalId}/civic-process/proposals`,
    {
      title: 'Capacity drill synthetic preflight proposal',
      body: 'Synthetic proposal proving the exact k6 session write path.',
      expectedOutcome: 'The exact long-load client is accepted before scaling.',
    },
    'propose',
    EXPECT_201,
  );
  if (!record(proposalRes, [201], 'propose')) return;

  const readbackRes = authedGet(
    mainToken,
    `/v1/signals/${signalId}/confirmation`,
    'synthetic_readback',
  );
  if (!record(readbackRes, [200], 'synthetic_readback')) return;
  try {
    if (JSON.parse(readbackRes.body)?.data?.confirmed !== true) {
      unexpectedFailureRate.add(true);
      endpointFailureRates.synthetic_readback.add(true);
      return;
    }
  } catch {
    unexpectedFailureRate.add(true);
    endpointFailureRates.synthetic_readback.add(true);
    return;
  }

  const arenaAccount = arenaAccounts[6];
  const arenaToken = capacitySessionToken(arenaAccount.accountId);
  const arenaSignalId = arenaSignals[1];
  const votingRes = authedGet(
    arenaToken,
    `/v1/signals/${arenaSignalId}/civic-process/voting`,
    'voting_read',
  );
  if (!record(votingRes, [200], 'voting_read')) return;

  let options = [];
  try {
    options = JSON.parse(votingRes.body)?.data?.options ?? [];
  } catch {
    unexpectedFailureRate.add(true);
    return;
  }
  if (options.length === 0) {
    unexpectedFailureRate.add(true);
    return;
  }

  const voteRes = authedWrite(
    'POST',
    arenaToken,
    `/v1/signals/${arenaSignalId}/civic-process/voting/vote`,
    { proposalId: options[0].proposalId },
    'vote',
    EXPECT_201,
  );
  record(voteRes, [201], 'vote');
}

export function probeReadiness() {
  const res = http.get(`${BASE_URL}/health/ready`, {
    tags: { endpoint: 'health_ready', kind: 'read' },
    responseCallback: EXPECT_200,
  });
  record(res, [200], 'health_ready');
  check(res, { 'stays ready under load': (r) => r.status === 200 });
  sleep(2);
}

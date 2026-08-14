import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

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

const MAIN_SIGNAL_COUNT_A = 20;
const MAIN_SIGNAL_COUNT_B = 3;
const ARENA_SIGNAL_COUNT = 8;
const ACCOUNT_COUNT_A = 225;
const ACCOUNT_COUNT_B = 25;
const ARENA_ACCOUNT_COUNT = 40;

function fixedId(group, index) {
  return `00000000-0000-4000-${group}-${index.toString().padStart(12, '0')}`;
}

function fixedIds(group, count) {
  return Array.from({ length: count }, (_unused, i) => fixedId(group, i + 1));
}

function fixedAccounts(accountGroup, actorGroup, emailPrefix, count) {
  return Array.from({ length: count }, (_unused, i) => ({
    accountId: fixedId(accountGroup, i + 1),
    actorId: fixedId(actorGroup, i + 1),
    email: `${emailPrefix}-${String(i + 1)}@loadtest.internal`,
  }));
}

const communityA = { id: fixedId('c001', 1), slug: 'capacity-drill-a' };
const communityB = { id: fixedId('c002', 1), slug: 'capacity-drill-b' };

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

export const options = {
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
  },
  thresholds: {
    unexpected_failure_rate: ['rate<0.01'], // < 1% of requests fail unexpectedly
    server_error_rate: ['rate<0.005'], // < 0.5% 5xx
    'http_req_duration{kind:read}': ['p(95)<500'],
    'http_req_duration{kind:write}': ['p(95)<800'],
    http_req_duration: ['p(99)<1500'],
  },
};

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
function record(res, expectedStatuses, label) {
  const ok = expectedStatuses.includes(res.status);
  unexpectedFailureRate.add(!ok);
  serverErrorRate.add(res.status >= 500);
  check(res, { [`${label} status is expected`]: () => ok });
  return ok;
}

function login(email, password) {
  const res = http.post(
    `${BASE_URL}/v1/authentication/password`,
    JSON.stringify({ email, password, clientType: 'mobile' }),
    { headers: { 'Content-Type': 'application/json' }, tags: { endpoint: 'login', kind: 'write' } },
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
  });
}

function authedWrite(method, token, path, body, endpoint) {
  const fn = method === 'PUT' ? http.put : http.post;
  return fn(`${BASE_URL}${path}`, JSON.stringify(body), {
    headers: { Authorization: `Session ${token}`, 'Content-Type': 'application/json' },
    tags: { endpoint, kind: 'write' },
  });
}

// Per-VU state: k6 gives every VU its own isolated JS runtime, so this is
// shared across iterations of the same VU (a persistent logged-in session,
// same as a real returning user) but never across VUs.
let cachedSession = null;
let cachedAccount = null;

export function userJourney() {
  if (!cachedSession) {
    const account = randomItem(mainAccounts);
    const token = login(account.email, account.password);
    if (!token) {
      randomSleep(1, 2);
      return;
    }
    cachedSession = token;
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
  );
  record(confirmRes, [200], 'confirm');

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
    );
    record(proposeRes, [201, 409], 'propose');
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

function voteJourney() {
  const account = randomItem(arenaAccounts);
  const token = login(account.email, account.password);
  if (!token) return;

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
  );
  // 201 the first time this actor votes on this process; 409
  // (already-voted) every subsequent concurrent/repeat attempt.
  record(voteRes, [201, 409], 'vote');
}

export function probeReadiness() {
  const res = http.get(`${BASE_URL}/health/ready`, { tags: { endpoint: 'health_ready' } });
  check(res, { 'stays ready under load': (r) => r.status === 200 });
  sleep(2);
}

import http from 'k6/http';
import { check, sleep } from 'k6';

/**
 * TOWN capacity smoke test — staging only.
 *
 * Simulates the scenario the platform admin asked for: ~100 people opening
 * the feed, ~50 authenticating, all inside the same window. v1 covers the
 * read side only (feed list, signal detail, civic-process reads) — it does
 * NOT confirm/propose/vote, because those are writes against real staging
 * data and this project's staging seed already has strict guards around
 * unexpected row counts (see ops/run-staging-seed.ts). Do not add write
 * traffic here without also updating those guards; otherwise a "successful"
 * load test will leave staging refusing its next seed run.
 *
 * SAFETY: this refuses to run against anything that isn't recognizably
 * staging. There is no override flag. If you need to test something else,
 * change BASE_URL deliberately and re-read this comment first.
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

// The 22 canonical community slugs (foundation-content.ts), spread across
// the seven countries currently live.
const COMMUNITY_SLUGS = [
  'milano-it',
  'munich-de',
  'koln-de',
  'dortmund-de',
  'stuttgart-de',
  'frankfurt-de',
  'arad-ro',
  'cluj-napoca-ro',
  'sibiu-ro',
  'iasi-ro',
  'timisoara-ro',
  'salzburg-at',
  'marseille-fr',
  'lyon-fr',
  'toulouse-fr',
  'budapest-hu',
  'szeged-hu',
  'madrid-es',
  'barcelona-es',
  'valencia-es',
  'sevilla-es',
  'malaga-es',
];

function randomItem(list) {
  return list[Math.floor(Math.random() * list.length)];
}

export const options = {
  scenarios: {
    feed_readers: {
      executor: 'ramping-vus',
      exec: 'browseFeed',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 50 }, // ~50 people opening the feed
        { duration: '30s', target: 100 }, // ramps to ~100 concurrent
        { duration: '2m', target: 100 }, // holds at 100 for the bulk of the run
        { duration: '30s', target: 0 },
      ],
    },
    readiness_probe: {
      executor: 'constant-vus',
      exec: 'probeReadiness',
      vus: 1,
      duration: '3m30s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'], // fewer than 1% of requests may fail
    'http_req_duration{endpoint:community_signals}': ['p(95)<800'],
    'http_req_duration{endpoint:signal_detail}': ['p(95)<500'],
    'http_req_duration{endpoint:civic_process}': ['p(95)<500'],
  },
};

export function browseFeed() {
  const slug = randomItem(COMMUNITY_SLUGS);

  const listRes = http.get(`${BASE_URL}/v1/communities/${slug}/signals`, {
    tags: { endpoint: 'community_signals' },
  });
  check(listRes, {
    'signals list is 200': (r) => r.status === 200,
  });

  let signalIds = [];
  try {
    const body = JSON.parse(listRes.body);
    signalIds = (body?.data?.signals || []).map((s) => s.id);
  } catch {
    // Non-JSON or unexpected shape counts as a failed check above; nothing
    // further to read for this iteration.
  }

  sleep(Math.random() * 1.5 + 0.5); // a human pauses before opening a signal

  if (signalIds.length > 0) {
    const signalId = randomItem(signalIds);
    const detailRes = http.get(`${BASE_URL}/v1/signals/${signalId}`, {
      tags: { endpoint: 'signal_detail' },
    });
    check(detailRes, {
      'signal detail is 200': (r) => r.status === 200,
    });

    // Roughly a third of readers go deep enough to open the civic process.
    if (Math.random() < 0.33) {
      const civicRes = http.get(`${BASE_URL}/v1/signals/${signalId}/civic-process`, {
        tags: { endpoint: 'civic_process' },
      });
      check(civicRes, {
        'civic-process is 200': (r) => r.status === 200,
      });
    }
  }

  sleep(Math.random() * 2 + 1);
}

export function probeReadiness() {
  const res = http.get(`${BASE_URL}/health/ready`, { tags: { endpoint: 'health_ready' } });
  check(res, {
    'stays ready under load': (r) => r.status === 200,
  });
  sleep(2);
}

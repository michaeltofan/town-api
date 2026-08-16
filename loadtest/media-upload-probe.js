import http from 'k6/http';
import { check } from 'k6';
import exec from 'k6/execution';

/**
 * TOWN Etapa 5 — media upload cost/traffic probe.
 *
 * Not a capacity/load test: a small, one-off measurement run against the
 * already-standing, permanent `capacity` environment (see
 * docs/operations/CAPACITY_DRILL_RUNBOOK.md), reusing its already-seeded
 * cycle-1 fixtures (src/platform/capacity-drill/fixtures.ts) rather than
 * provisioning anything new. Uploads a handful of real requests per size
 * bucket to both media-upload routes so the real per-request duration and
 * the server's own echoed byteSize can be read back from deployment logs
 * (the media_upload structured log line added alongside this script) and
 * used to compute real Cloudflare R2 cost -- not a guessed number.
 *
 * Size buckets matter more than volume here: R2's pricing is per-byte and
 * per-operation, not concurrency-dependent, so this does not need
 * capacity-1000.js-scale concurrent traffic to produce an accurate cost
 * model -- it needs real requests at the sizes that will actually ship
 * (post-Etapa-5-compression) so the byte assumption is verified, not
 * assumed.
 *
 * SAFETY: same host allowlist as capacity-1000.js, duplicated deliberately
 * per that file's own convention.
 */

const BASE_URL = __ENV.BASE_URL || 'https://api-staging.towncivic.org';

const ALLOWED_HOST_PATTERNS = [
  /^https:\/\/api-staging\.towncivic\.org$/,
  /^https:\/\/[a-z0-9-]+\.up\.railway\.app$/,
];

if (!ALLOWED_HOST_PATTERNS.some((pattern) => pattern.test(BASE_URL))) {
  throw new Error(
    `Refusing to run: BASE_URL "${BASE_URL}" does not look like a staging host. ` +
      'Allowed: https://api-staging.towncivic.org or a *.up.railway.app Railway domain.',
  );
}
if (BASE_URL.includes('api.towncivic.org')) {
  throw new Error('Refusing to run: BASE_URL resolves to production. Aborting.');
}

// Mirrors src/platform/capacity-drill/fixtures.ts, cycle 1 only -- this
// probe reads already-seeded fixtures, it never provisions or resets.
function fixedId(group, index) {
  return `00000000-0000-4000-${group}-${index.toString().padStart(12, '0')}`;
}

const COMMUNITY_A_SLUG = 'capacity-drill-a';
const MAIN_SIGNAL_A_1 = fixedId('c101', 1);
const MAIN_ACCOUNT_A_1 = fixedId('c201', 1);

const CAPACITY_DRILL_AUTH_SECRET = __ENV.CAPACITY_DRILL_AUTH_SECRET;
if (!CAPACITY_DRILL_AUTH_SECRET || CAPACITY_DRILL_AUTH_SECRET.length < 32) {
  throw new Error('CAPACITY_DRILL_AUTH_SECRET must contain at least 32 characters');
}

import crypto from 'k6/crypto';

function capacitySessionToken(accountId) {
  return crypto.hmac(
    'sha256',
    CAPACITY_DRILL_AUTH_SECRET,
    `town.capacity_drill_session.v1\0${accountId}`,
    'hex',
  );
}

const SESSION_TOKEN = capacitySessionToken(MAIN_ACCOUNT_A_1);

// Real magic bytes (JPEG SOI + APP0 marker), then filler -- server-side
// magic-byte validation (matchesMemberSignalMediaMagic /
// matchesDiscussionMediaMagic) only inspects the first few header bytes,
// not full JPEG structure, so this reaches exact target byte counts
// without needing a real image encoder in k6's JS runtime.
const JPEG_HEADER = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

function jpegOfSize(bytes) {
  const buffer = new Uint8Array(bytes);
  buffer.set(JPEG_HEADER, 0);
  return buffer.buffer;
}

// Size buckets: what Etapa 5's browser compression (town-public/script.js,
// IMAGE_COMPRESS_TARGET_BYTES) actually produces in practice, verified in
// PR #135 -- a 7.3MB 3000x2000 photo compressed to ~952KB. These buckets
// bracket that real result to get a representative average/spread rather
// than a single point sample.
const SIZE_BUCKETS_BYTES = [
  200 * 1024, // small photo, already under the compression target
  600 * 1024, // typical compressed result, lower end
  950 * 1024, // typical compressed result, matches the measured PR #135 case
  1.4 * 1024 * 1024, // compressed result, upper end near the 1.5MB target
];

export const options = {
  scenarios: {
    member_signal_media: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: SIZE_BUCKETS_BYTES.length * 3,
      maxDuration: '3m',
      exec: 'memberSignalMediaProbe',
    },
    discussion_media: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: SIZE_BUCKETS_BYTES.length * 3,
      maxDuration: '3m',
      startTime: '3m',
      exec: 'discussionMediaProbe',
    },
  },
};

function sizeForIteration(iteration) {
  return SIZE_BUCKETS_BYTES[iteration % SIZE_BUCKETS_BYTES.length];
}

export function memberSignalMediaProbe() {
  const bytes = sizeForIteration(exec.scenario.iterationInTest);
  const res = http.post(
    `${BASE_URL}/v1/communities/${COMMUNITY_A_SLUG}/signals/media`,
    jpegOfSize(bytes),
    {
      headers: { Authorization: `Session ${SESSION_TOKEN}`, 'Content-Type': 'image/jpeg' },
      tags: { endpoint: 'member_signal_media', bytes: String(bytes) },
    },
  );
  check(res, {
    'member_signal_media status 201': (r) => r.status === 201,
  });
}

export function discussionMediaProbe() {
  const bytes = sizeForIteration(exec.scenario.iterationInTest);
  const res = http.post(
    `${BASE_URL}/v1/signals/${MAIN_SIGNAL_A_1}/discussion-session/media`,
    jpegOfSize(bytes),
    {
      headers: { Authorization: `Session ${SESSION_TOKEN}`, 'Content-Type': 'image/jpeg' },
      tags: { endpoint: 'discussion_media', bytes: String(bytes) },
    },
  );
  check(res, {
    'discussion_media status 201': (r) => r.status === 201,
  });
}

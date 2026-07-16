import { deterministicSha256 } from '../../identity/hashing.js';
import {
  IDENTITY_ACCOUNT_IDS,
  IDENTITY_FIXTURE_TIMESTAMPS,
} from '../../identity/fixtures/content.js';
import {
  addHours,
  addMinutes,
  computeAbsoluteExpiresAt,
  computeIdleExpiresAt,
  computeSetupGrantExpiresAt,
  SENSITIVE_REAUTH_FRESHNESS_MINUTES,
  SESSION_IDLE_TIMEOUT_MINUTES,
} from '../policy.js';

/**
 * Deterministic ceremony fixtures for Authentication Ceremony Foundation V1 Slice 1.
 * Fixed UUIDs, timestamps, and byte sequences. Never used at application startup.
 */

export const CEREMONY_FIXTURE_TIMESTAMPS = {
  ...IDENTITY_FIXTURE_TIMESTAMPS,
  /** Canonical "now" for evaluating active ceremony fixtures. */
  now: '2026-07-16T10:30:00.000Z',
  sessionCreated: '2026-07-16T10:20:00.000Z',
  sessionTouched: '2026-07-16T10:25:00.000Z',
  sensitiveAuthAt: '2026-07-16T10:28:00.000Z',
  staleAuthAt: '2026-07-16T10:10:00.000Z',
  idleExpiredCreated: '2026-07-16T09:00:00.000Z',
  absoluteExpiredCreated: '2026-07-15T09:00:00.000Z',
  rateWindowStart: '2026-07-16T10:00:00.000Z',
  rateWindowEnd: '2026-07-16T11:00:00.000Z',
  blockedUntil: '2026-07-16T11:30:00.000Z',
} as const;

export const CEREMONY_SETUP_GRANT_IDS = {
  active: '17000000-0000-4000-8000-000000000001',
  expired: '17000000-0000-4000-8000-000000000002',
  consumed: '17000000-0000-4000-8000-000000000003',
  revoked: '17000000-0000-4000-8000-000000000004',
} as const;

export const CEREMONY_SESSION_IDS = {
  activeWeb: '18000000-0000-4000-8000-000000000001',
  activeMobile: '18000000-0000-4000-8000-000000000002',
  idleExpired: '18000000-0000-4000-8000-000000000003',
  absoluteExpired: '18000000-0000-4000-8000-000000000004',
  revoked: '18000000-0000-4000-8000-000000000005',
  sensitiveFresh: '18000000-0000-4000-8000-000000000006',
  sensitiveStale: '18000000-0000-4000-8000-000000000007',
} as const;

export const CEREMONY_RATE_LIMIT_IDS = {
  emailVerificationRequest: '19000000-0000-4000-8000-000000000001',
  passkeyAssertion: '19000000-0000-4000-8000-000000000002',
  recoveryRequest: '19000000-0000-4000-8000-000000000003',
  blocked: '19000000-0000-4000-8000-000000000004',
} as const;

export const CEREMONY_EVENT_IDS = {
  sessionCreated: '1a000000-0000-4000-8000-000000000001',
  sessionRotated: '1a000000-0000-4000-8000-000000000002',
  sessionRevoked: '1a000000-0000-4000-8000-000000000003',
  rateLimitTriggered: '1a000000-0000-4000-8000-000000000004',
} as const;

export const CEREMONY_HASHES = {
  setupActive: deterministicSha256('fixture-setup-grant-active'),
  setupExpired: deterministicSha256('fixture-setup-grant-expired'),
  setupConsumed: deterministicSha256('fixture-setup-grant-consumed'),
  setupRevoked: deterministicSha256('fixture-setup-grant-revoked'),
  sessionWeb: deterministicSha256('fixture-session-token-web'),
  sessionMobile: deterministicSha256('fixture-session-token-mobile'),
  sessionIdleExpired: deterministicSha256('fixture-session-token-idle-expired'),
  sessionAbsoluteExpired: deterministicSha256('fixture-session-token-absolute-expired'),
  sessionRevoked: deterministicSha256('fixture-session-token-revoked'),
  sessionSensitiveFresh: deterministicSha256('fixture-session-token-sensitive-fresh'),
  sessionSensitiveStale: deterministicSha256('fixture-session-token-sensitive-stale'),
  rateEmailSubject: deterministicSha256('fixture-rate-subject-email-verification'),
  ratePasskeySubject: deterministicSha256('fixture-rate-subject-passkey-assertion'),
  rateRecoverySubject: deterministicSha256('fixture-rate-subject-recovery-request'),
  rateBlockedSubject: deterministicSha256('fixture-rate-subject-blocked'),
} as const;

export const CEREMONY_ACCOUNT_IDS = {
  pendingPasskey: IDENTITY_ACCOUNT_IDS.pendingPasskey,
  active: IDENTITY_ACCOUNT_IDS.active,
} as const;

const sessionCreated = CEREMONY_FIXTURE_TIMESTAMPS.sessionCreated;
const absoluteForSession = computeAbsoluteExpiresAt(sessionCreated);
const idleForSession = computeIdleExpiresAt(sessionCreated, absoluteForSession);

const idleExpiredCreated = CEREMONY_FIXTURE_TIMESTAMPS.idleExpiredCreated;
const idleExpiredAbsolute = computeAbsoluteExpiresAt(idleExpiredCreated);
const idleExpiredIdle = addMinutes(idleExpiredCreated, SESSION_IDLE_TIMEOUT_MINUTES);

const absoluteExpiredCreated = CEREMONY_FIXTURE_TIMESTAMPS.absoluteExpiredCreated;
const absoluteExpiredAbsolute = computeAbsoluteExpiresAt(absoluteExpiredCreated);
const absoluteExpiredIdle = absoluteExpiredAbsolute;

export const CEREMONY_EXPECTED_WINDOWS = {
  /** Active fixture grant uses a far-future expiry so it remains active at fixture `now`. */
  setupActiveExpiresAt: CEREMONY_FIXTURE_TIMESTAMPS.farFuture,
  setupActivePolicyExpiryExample: computeSetupGrantExpiresAt(CEREMONY_FIXTURE_TIMESTAMPS.t2),
  sessionCreated,
  sessionAbsoluteExpiresAt: absoluteForSession,
  sessionIdleExpiresAt: idleForSession,
  idleExpiredCreated,
  idleExpiredIdleExpiresAt: idleExpiredIdle,
  idleExpiredAbsoluteExpiresAt: idleExpiredAbsolute,
  absoluteExpiredCreated,
  absoluteExpiredAbsoluteExpiresAt: absoluteExpiredAbsolute,
  absoluteExpiredIdleExpiresAt: absoluteExpiredIdle,
  sensitiveFreshAuthenticatedAt: CEREMONY_FIXTURE_TIMESTAMPS.sensitiveAuthAt,
  sensitiveStaleAuthenticatedAt: CEREMONY_FIXTURE_TIMESTAMPS.staleAuthAt,
  sensitiveFreshCutoff: addMinutes(
    CEREMONY_FIXTURE_TIMESTAMPS.sensitiveAuthAt,
    SENSITIVE_REAUTH_FRESHNESS_MINUTES,
  ),
  sensitiveStaleCutoff: addMinutes(
    CEREMONY_FIXTURE_TIMESTAMPS.staleAuthAt,
    SENSITIVE_REAUTH_FRESHNESS_MINUTES,
  ),
  nowPlusOneHour: addHours(CEREMONY_FIXTURE_TIMESTAMPS.now, 1),
} as const;

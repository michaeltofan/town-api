import type { Database } from '../../db/client.js';
import { accountSessions, setupGrants } from '../../db/schema.js';
import { loadIdentityFixtures } from '../../identity/fixtures/load.js';
import { appendIdentitySecurityEvent } from '../../identity/repositories/security-events.js';
import { createAccountSession, revokeAccountSession } from '../repositories/account-sessions.js';
import {
  getOrCreateCeremonyRateLimitBucket,
  incrementCeremonyRateLimit,
  setCeremonyRateLimitBlockedUntil,
} from '../repositories/ceremony-rate-limits.js';
import {
  createSetupGrant,
  consumeSetupGrant,
  revokeSetupGrant,
} from '../repositories/setup-grants.js';
import {
  CEREMONY_ACCOUNT_IDS,
  CEREMONY_EVENT_IDS,
  CEREMONY_EXPECTED_WINDOWS,
  CEREMONY_FIXTURE_TIMESTAMPS,
  CEREMONY_HASHES,
  CEREMONY_RATE_LIMIT_IDS,
  CEREMONY_SESSION_IDS,
  CEREMONY_SETUP_GRANT_IDS,
} from './content.js';

type Db = Database['db'];

async function insertSessionRow(
  db: Db,
  values: typeof accountSessions.$inferInsert,
): Promise<void> {
  await db.insert(accountSessions).values(values);
}

/**
 * Loads deterministic identity + ceremony fixtures into an already-migrated database.
 * Does not truncate. Does not modify the controlled test actor.
 * Must never run at application startup.
 */
export async function loadCeremonyFixtures(db: Db): Promise<void> {
  await loadIdentityFixtures(db);

  const {
    t0,
    t1,
    t2,
    now,
    sessionCreated,
    sensitiveAuthAt,
    staleAuthAt,
    rateWindowStart,
    rateWindowEnd,
    blockedUntil,
    expiredAt,
    farFuture,
  } = CEREMONY_FIXTURE_TIMESTAMPS;

  await createSetupGrant(db, {
    id: CEREMONY_SETUP_GRANT_IDS.active,
    accountId: CEREMONY_ACCOUNT_IDS.pendingPasskey,
    tokenHash: CEREMONY_HASHES.setupActive,
    purpose: 'initial_passkey_registration',
    createdAt: t2,
    expiresAt: CEREMONY_EXPECTED_WINDOWS.setupActiveExpiresAt,
  });

  await db.insert(setupGrants).values({
    id: CEREMONY_SETUP_GRANT_IDS.expired,
    accountId: CEREMONY_ACCOUNT_IDS.pendingPasskey,
    tokenHash: CEREMONY_HASHES.setupExpired,
    purpose: 'initial_passkey_registration',
    createdAt: expiredAt,
    expiresAt: t0,
    consumedAt: null,
    revokedAt: null,
  });

  await createSetupGrant(db, {
    id: CEREMONY_SETUP_GRANT_IDS.consumed,
    accountId: CEREMONY_ACCOUNT_IDS.pendingPasskey,
    tokenHash: CEREMONY_HASHES.setupConsumed,
    purpose: 'initial_passkey_registration',
    createdAt: t2,
    expiresAt: farFuture,
  });
  await consumeSetupGrant(db, {
    grantId: CEREMONY_SETUP_GRANT_IDS.consumed,
    accountId: CEREMONY_ACCOUNT_IDS.pendingPasskey,
    purpose: 'initial_passkey_registration',
    now: t2,
  });

  await createSetupGrant(db, {
    id: CEREMONY_SETUP_GRANT_IDS.revoked,
    accountId: CEREMONY_ACCOUNT_IDS.pendingPasskey,
    tokenHash: CEREMONY_HASHES.setupRevoked,
    purpose: 'initial_passkey_registration',
    createdAt: t2,
    expiresAt: farFuture,
  });
  await revokeSetupGrant(db, {
    grantId: CEREMONY_SETUP_GRANT_IDS.revoked,
    now: t2,
  });

  await createAccountSession(db, {
    id: CEREMONY_SESSION_IDS.activeWeb,
    accountId: CEREMONY_ACCOUNT_IDS.active,
    tokenHash: CEREMONY_HASHES.sessionWeb,
    clientType: 'web',
    createdAt: sessionCreated,
    eventId: CEREMONY_EVENT_IDS.sessionCreated,
  });

  await createAccountSession(db, {
    id: CEREMONY_SESSION_IDS.activeMobile,
    accountId: CEREMONY_ACCOUNT_IDS.active,
    tokenHash: CEREMONY_HASHES.sessionMobile,
    clientType: 'mobile',
    createdAt: sessionCreated,
  });

  await insertSessionRow(db, {
    id: CEREMONY_SESSION_IDS.idleExpired,
    accountId: CEREMONY_ACCOUNT_IDS.active,
    tokenHash: CEREMONY_HASHES.sessionIdleExpired,
    clientType: 'web',
    createdAt: CEREMONY_EXPECTED_WINDOWS.idleExpiredCreated,
    authenticatedAt: CEREMONY_EXPECTED_WINDOWS.idleExpiredCreated,
    lastSeenAt: CEREMONY_EXPECTED_WINDOWS.idleExpiredCreated,
    idleExpiresAt: CEREMONY_EXPECTED_WINDOWS.idleExpiredIdleExpiresAt,
    absoluteExpiresAt: CEREMONY_EXPECTED_WINDOWS.idleExpiredAbsoluteExpiresAt,
    revokedAt: null,
    revocationReason: null,
    recoveryRecentAt: null,
    securityVersion: 1,
  });

  await insertSessionRow(db, {
    id: CEREMONY_SESSION_IDS.absoluteExpired,
    accountId: CEREMONY_ACCOUNT_IDS.active,
    tokenHash: CEREMONY_HASHES.sessionAbsoluteExpired,
    clientType: 'web',
    createdAt: CEREMONY_EXPECTED_WINDOWS.absoluteExpiredCreated,
    authenticatedAt: CEREMONY_EXPECTED_WINDOWS.absoluteExpiredCreated,
    lastSeenAt: CEREMONY_EXPECTED_WINDOWS.absoluteExpiredCreated,
    idleExpiresAt: CEREMONY_EXPECTED_WINDOWS.absoluteExpiredIdleExpiresAt,
    absoluteExpiresAt: CEREMONY_EXPECTED_WINDOWS.absoluteExpiredAbsoluteExpiresAt,
    revokedAt: null,
    revocationReason: null,
    recoveryRecentAt: null,
    securityVersion: 1,
  });

  await createAccountSession(db, {
    id: CEREMONY_SESSION_IDS.revoked,
    accountId: CEREMONY_ACCOUNT_IDS.active,
    tokenHash: CEREMONY_HASHES.sessionRevoked,
    clientType: 'web',
    createdAt: sessionCreated,
  });
  await revokeAccountSession(db, {
    sessionId: CEREMONY_SESSION_IDS.revoked,
    reason: 'logout',
    now: CEREMONY_FIXTURE_TIMESTAMPS.sessionTouched,
    eventId: CEREMONY_EVENT_IDS.sessionRevoked,
  });

  await createAccountSession(db, {
    id: CEREMONY_SESSION_IDS.sensitiveFresh,
    accountId: CEREMONY_ACCOUNT_IDS.active,
    tokenHash: CEREMONY_HASHES.sessionSensitiveFresh,
    clientType: 'web',
    createdAt: sensitiveAuthAt,
    authenticatedAt: sensitiveAuthAt,
  });

  await createAccountSession(db, {
    id: CEREMONY_SESSION_IDS.sensitiveStale,
    accountId: CEREMONY_ACCOUNT_IDS.active,
    tokenHash: CEREMONY_HASHES.sessionSensitiveStale,
    clientType: 'web',
    createdAt: staleAuthAt,
    authenticatedAt: staleAuthAt,
    recoveryRecentAt: now,
  });

  await getOrCreateCeremonyRateLimitBucket(db, {
    id: CEREMONY_RATE_LIMIT_IDS.emailVerificationRequest,
    scope: 'email_verification_request_email',
    subjectHash: CEREMONY_HASHES.rateEmailSubject,
    windowStartedAt: rateWindowStart,
    windowExpiresAt: rateWindowEnd,
    createdAt: rateWindowStart,
  });
  await incrementCeremonyRateLimit(db, {
    id: CEREMONY_RATE_LIMIT_IDS.emailVerificationRequest,
    now: t1,
  });

  await getOrCreateCeremonyRateLimitBucket(db, {
    id: CEREMONY_RATE_LIMIT_IDS.passkeyAssertion,
    scope: 'passkey_assertion_ip',
    subjectHash: CEREMONY_HASHES.ratePasskeySubject,
    windowStartedAt: rateWindowStart,
    windowExpiresAt: rateWindowEnd,
    createdAt: rateWindowStart,
  });
  await incrementCeremonyRateLimit(db, {
    id: CEREMONY_RATE_LIMIT_IDS.passkeyAssertion,
    now: t1,
  });
  await incrementCeremonyRateLimit(db, {
    id: CEREMONY_RATE_LIMIT_IDS.passkeyAssertion,
    now: t2,
  });

  await getOrCreateCeremonyRateLimitBucket(db, {
    id: CEREMONY_RATE_LIMIT_IDS.recoveryRequest,
    scope: 'recovery_request_email',
    subjectHash: CEREMONY_HASHES.rateRecoverySubject,
    windowStartedAt: rateWindowStart,
    windowExpiresAt: rateWindowEnd,
    createdAt: rateWindowStart,
  });

  await getOrCreateCeremonyRateLimitBucket(db, {
    id: CEREMONY_RATE_LIMIT_IDS.blocked,
    scope: 'email_verification_attempt_email_ip',
    subjectHash: CEREMONY_HASHES.rateBlockedSubject,
    windowStartedAt: rateWindowStart,
    windowExpiresAt: rateWindowEnd,
    createdAt: rateWindowStart,
  });
  await incrementCeremonyRateLimit(db, {
    id: CEREMONY_RATE_LIMIT_IDS.blocked,
    now: t1,
  });
  await setCeremonyRateLimitBlockedUntil(db, {
    id: CEREMONY_RATE_LIMIT_IDS.blocked,
    blockedUntil,
    now: t2,
  });

  await appendIdentitySecurityEvent(db, {
    id: CEREMONY_EVENT_IDS.sessionRotated,
    accountId: CEREMONY_ACCOUNT_IDS.active,
    eventType: 'session_rotated',
    occurredAt: t2,
    metadata: {
      previousSessionId: CEREMONY_SESSION_IDS.activeWeb,
      replacementSessionId: CEREMONY_SESSION_IDS.activeMobile,
    },
  });

  await appendIdentitySecurityEvent(db, {
    id: CEREMONY_EVENT_IDS.rateLimitTriggered,
    accountId: CEREMONY_ACCOUNT_IDS.active,
    eventType: 'rate_limit_triggered',
    occurredAt: t2,
    metadata: {
      scope: 'email_verification_attempt_email_ip',
      bucketId: CEREMONY_RATE_LIMIT_IDS.blocked,
    },
  });
}

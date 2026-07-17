import { randomUUID } from 'node:crypto';
import type { Database } from '../../db/client.js';
import type { CeremonyRateLimitScope } from '../../db/schema.js';
import { appendIdentitySecurityEvent } from '../../identity/repositories/security-events.js';
import {
  getOrCreateCeremonyRateLimitBucket,
  incrementCeremonyRateLimit,
} from '../repositories/ceremony-rate-limits.js';
import { hashRateLimitSubject } from './crypto.js';
import {
  ACCOUNT_RECOVERY_ATTEMPT_CHALLENGE_LIMIT,
  ACCOUNT_RECOVERY_ATTEMPT_EMAIL_IP_LIMIT_30M,
  ACCOUNT_RECOVERY_REQUEST_EMAIL_LIMIT_24H,
  ACCOUNT_RECOVERY_REQUEST_IP_LIMIT_24H,
  RECOVERY_OPTIONS_GRANT_LIMIT,
  RECOVERY_VERIFICATION_GRANT_LIMIT,
} from './policy.js';

type Db = Database['db'];

function floorWindowStart(nowMs: number, windowMs: number): Date {
  return new Date(Math.floor(nowMs / windowMs) * windowMs);
}

async function countInWindow(
  db: Db,
  input: {
    rateLimitHashKey: string;
    scope: CeremonyRateLimitScope;
    subject: string;
    now: string;
    windowMs: number;
    windowExpiresOffsetMs: number;
  },
): Promise<{ count: number; bucketId: string }> {
  const nowMs = new Date(input.now).getTime();
  const windowStartedAt = floorWindowStart(nowMs, input.windowMs).toISOString();
  const windowExpiresAt = new Date(
    new Date(windowStartedAt).getTime() + input.windowExpiresOffsetMs,
  ).toISOString();
  const subjectHash = hashRateLimitSubject({
    hashKey: input.rateLimitHashKey,
    scope: input.scope,
    subject: input.subject,
  });
  const bucket = await getOrCreateCeremonyRateLimitBucket(db, {
    id: randomUUID(),
    scope: input.scope,
    subjectHash,
    windowStartedAt,
    windowExpiresAt,
    createdAt: input.now,
  });
  return { count: bucket.attemptCount, bucketId: bucket.id };
}

async function incrementWindow(
  db: Db,
  input: {
    rateLimitHashKey: string;
    scope: CeremonyRateLimitScope;
    subject: string;
    now: string;
    windowMs: number;
    windowExpiresOffsetMs: number;
  },
): Promise<number> {
  const { bucketId } = await countInWindow(db, input);
  const updated = await incrementCeremonyRateLimit(db, { id: bucketId, now: input.now });
  return updated.attemptCount;
}

export async function isRecoveryRequestThrottled(
  db: Db,
  input: {
    rateLimitHashKey: string;
    emailNormalized: string;
    ip: string;
    now: string;
  },
): Promise<boolean> {
  const email24 = await countInWindow(db, {
    rateLimitHashKey: input.rateLimitHashKey,
    scope: 'recovery_request_email',
    subject: `email:${input.emailNormalized}:24h`,
    now: input.now,
    windowMs: 24 * 60 * 60_000,
    windowExpiresOffsetMs: 24 * 60 * 60_000,
  });
  if (email24.count >= ACCOUNT_RECOVERY_REQUEST_EMAIL_LIMIT_24H) {
    return true;
  }

  const ip24 = await countInWindow(db, {
    rateLimitHashKey: input.rateLimitHashKey,
    scope: 'recovery_request_ip',
    subject: `ip:${input.ip}:24h`,
    now: input.now,
    windowMs: 24 * 60 * 60_000,
    windowExpiresOffsetMs: 24 * 60 * 60_000,
  });
  return ip24.count >= ACCOUNT_RECOVERY_REQUEST_IP_LIMIT_24H;
}

export async function recordRecoveryRequestAttempt(
  db: Db,
  input: {
    rateLimitHashKey: string;
    emailNormalized: string;
    ip: string;
    now: string;
    throttled: boolean;
    requestId?: string | null;
  },
): Promise<void> {
  await incrementWindow(db, {
    rateLimitHashKey: input.rateLimitHashKey,
    scope: 'recovery_request_email',
    subject: `email:${input.emailNormalized}:24h`,
    now: input.now,
    windowMs: 24 * 60 * 60_000,
    windowExpiresOffsetMs: 24 * 60 * 60_000,
  });
  await incrementWindow(db, {
    rateLimitHashKey: input.rateLimitHashKey,
    scope: 'recovery_request_ip',
    subject: `ip:${input.ip}:24h`,
    now: input.now,
    windowMs: 24 * 60 * 60_000,
    windowExpiresOffsetMs: 24 * 60 * 60_000,
  });

  if (input.throttled) {
    await appendIdentitySecurityEvent(db, {
      id: randomUUID(),
      accountId: null,
      eventType: 'rate_limit_triggered',
      occurredAt: input.now,
      requestId: input.requestId ?? null,
      metadata: {
        purpose: 'recover_account',
        scope: 'recovery_request',
      },
    });
  }
}

export async function isRecoveryEmailAttemptThrottled(
  db: Db,
  input: {
    rateLimitHashKey: string;
    emailNormalized: string;
    ip: string;
    challengeId: string;
    now: string;
  },
): Promise<boolean> {
  const emailIp = await countInWindow(db, {
    rateLimitHashKey: input.rateLimitHashKey,
    scope: 'recovery_email_attempt_email_ip',
    subject: `email_ip:${input.emailNormalized}:${input.ip}:30m`,
    now: input.now,
    windowMs: 30 * 60_000,
    windowExpiresOffsetMs: 30 * 60_000,
  });
  if (emailIp.count >= ACCOUNT_RECOVERY_ATTEMPT_EMAIL_IP_LIMIT_30M) {
    return true;
  }

  const challenge = await countInWindow(db, {
    rateLimitHashKey: input.rateLimitHashKey,
    scope: 'recovery_email_attempt_challenge',
    subject: `challenge:${input.challengeId}`,
    now: input.now,
    windowMs: 24 * 60 * 60_000,
    windowExpiresOffsetMs: 24 * 60 * 60_000,
  });
  return challenge.count >= ACCOUNT_RECOVERY_ATTEMPT_CHALLENGE_LIMIT;
}

export async function recordRecoveryEmailFailedAttempt(
  db: Db,
  input: {
    rateLimitHashKey: string;
    emailNormalized: string;
    ip: string;
    challengeId: string;
    now: string;
    requestId?: string | null;
    accountId?: string | null;
  },
): Promise<void> {
  const emailIpCount = await incrementWindow(db, {
    rateLimitHashKey: input.rateLimitHashKey,
    scope: 'recovery_email_attempt_email_ip',
    subject: `email_ip:${input.emailNormalized}:${input.ip}:30m`,
    now: input.now,
    windowMs: 30 * 60_000,
    windowExpiresOffsetMs: 30 * 60_000,
  });
  const challengeCount = await incrementWindow(db, {
    rateLimitHashKey: input.rateLimitHashKey,
    scope: 'recovery_email_attempt_challenge',
    subject: `challenge:${input.challengeId}`,
    now: input.now,
    windowMs: 24 * 60 * 60_000,
    windowExpiresOffsetMs: 24 * 60 * 60_000,
  });

  if (
    emailIpCount >= ACCOUNT_RECOVERY_ATTEMPT_EMAIL_IP_LIMIT_30M ||
    challengeCount >= ACCOUNT_RECOVERY_ATTEMPT_CHALLENGE_LIMIT
  ) {
    await appendIdentitySecurityEvent(db, {
      id: randomUUID(),
      accountId: input.accountId ?? null,
      eventType: 'rate_limit_triggered',
      occurredAt: input.now,
      requestId: input.requestId ?? null,
      metadata: {
        purpose: 'recover_account',
        scope:
          emailIpCount >= ACCOUNT_RECOVERY_ATTEMPT_EMAIL_IP_LIMIT_30M
            ? 'recovery_email_attempt_email_ip'
            : 'recovery_email_attempt_challenge',
      },
    });
  }
}

const GRANT_WINDOW_MS = 24 * 60 * 60_000;

export async function isRecoveryOptionsGrantThrottled(
  db: Db,
  input: { rateLimitHashKey: string; grantId: string; now: string },
): Promise<boolean> {
  const bucket = await countInWindow(db, {
    rateLimitHashKey: input.rateLimitHashKey,
    scope: 'recovery_options_grant',
    subject: `grant:${input.grantId}`,
    now: input.now,
    windowMs: GRANT_WINDOW_MS,
    windowExpiresOffsetMs: GRANT_WINDOW_MS,
  });
  return bucket.count >= RECOVERY_OPTIONS_GRANT_LIMIT;
}

export async function recordRecoveryOptionsGrantAttempt(
  db: Db,
  input: {
    rateLimitHashKey: string;
    grantId: string;
    accountId: string;
    now: string;
    throttled: boolean;
    requestId?: string | null;
  },
): Promise<number> {
  const count = await incrementWindow(db, {
    rateLimitHashKey: input.rateLimitHashKey,
    scope: 'recovery_options_grant',
    subject: `grant:${input.grantId}`,
    now: input.now,
    windowMs: GRANT_WINDOW_MS,
    windowExpiresOffsetMs: GRANT_WINDOW_MS,
  });
  if (input.throttled || count >= RECOVERY_OPTIONS_GRANT_LIMIT) {
    await appendIdentitySecurityEvent(db, {
      id: randomUUID(),
      accountId: input.accountId,
      eventType: 'rate_limit_triggered',
      occurredAt: input.now,
      requestId: input.requestId ?? null,
      metadata: {
        purpose: 'recover_register',
        scope: 'recovery_options_grant',
      },
    });
  }
  return count;
}

export async function isRecoveryVerificationGrantThrottled(
  db: Db,
  input: { rateLimitHashKey: string; grantId: string; now: string },
): Promise<boolean> {
  const bucket = await countInWindow(db, {
    rateLimitHashKey: input.rateLimitHashKey,
    scope: 'recovery_verification_grant',
    subject: `grant:${input.grantId}`,
    now: input.now,
    windowMs: GRANT_WINDOW_MS,
    windowExpiresOffsetMs: GRANT_WINDOW_MS,
  });
  return bucket.count >= RECOVERY_VERIFICATION_GRANT_LIMIT;
}

export async function recordRecoveryVerificationFailedAttempt(
  db: Db,
  input: {
    rateLimitHashKey: string;
    grantId: string;
    accountId: string | null;
    now: string;
    requestId?: string | null;
    failureCategory: string;
  },
): Promise<number> {
  const count = await incrementWindow(db, {
    rateLimitHashKey: input.rateLimitHashKey,
    scope: 'recovery_verification_grant',
    subject: `grant:${input.grantId}`,
    now: input.now,
    windowMs: GRANT_WINDOW_MS,
    windowExpiresOffsetMs: GRANT_WINDOW_MS,
  });
  if (count >= RECOVERY_VERIFICATION_GRANT_LIMIT) {
    await appendIdentitySecurityEvent(db, {
      id: randomUUID(),
      accountId: input.accountId,
      eventType: 'rate_limit_triggered',
      occurredAt: input.now,
      requestId: input.requestId ?? null,
      metadata: {
        purpose: 'recover_register',
        scope: 'recovery_verification_grant',
        failureCategory: input.failureCategory,
      },
    });
  }
  return count;
}

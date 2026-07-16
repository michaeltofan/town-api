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
  EMAIL_VERIFICATION_ATTEMPT_EMAIL_IP_LIMIT_30M,
  EMAIL_VERIFICATION_REQUEST_EMAIL_LIMIT_15M,
  EMAIL_VERIFICATION_REQUEST_EMAIL_LIMIT_24H,
  EMAIL_VERIFICATION_REQUEST_IP_LIMIT_15M,
  EMAIL_VERIFICATION_REQUEST_IP_LIMIT_24H,
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

export async function isEmailVerificationRequestThrottled(
  db: Db,
  input: {
    rateLimitHashKey: string;
    emailNormalized: string;
    ip: string;
    now: string;
  },
): Promise<boolean> {
  const email15 = await countInWindow(db, {
    rateLimitHashKey: input.rateLimitHashKey,
    scope: 'email_verification_request_email',
    subject: `email:${input.emailNormalized}:15m`,
    now: input.now,
    windowMs: 15 * 60_000,
    windowExpiresOffsetMs: 15 * 60_000,
  });
  if (email15.count >= EMAIL_VERIFICATION_REQUEST_EMAIL_LIMIT_15M) {
    return true;
  }

  const email24 = await countInWindow(db, {
    rateLimitHashKey: input.rateLimitHashKey,
    scope: 'email_verification_request_email',
    subject: `email:${input.emailNormalized}:24h`,
    now: input.now,
    windowMs: 24 * 60 * 60_000,
    windowExpiresOffsetMs: 24 * 60 * 60_000,
  });
  if (email24.count >= EMAIL_VERIFICATION_REQUEST_EMAIL_LIMIT_24H) {
    return true;
  }

  const ip15 = await countInWindow(db, {
    rateLimitHashKey: input.rateLimitHashKey,
    scope: 'email_verification_request_ip',
    subject: `ip:${input.ip}:15m`,
    now: input.now,
    windowMs: 15 * 60_000,
    windowExpiresOffsetMs: 15 * 60_000,
  });
  if (ip15.count >= EMAIL_VERIFICATION_REQUEST_IP_LIMIT_15M) {
    return true;
  }

  const ip24 = await countInWindow(db, {
    rateLimitHashKey: input.rateLimitHashKey,
    scope: 'email_verification_request_ip',
    subject: `ip:${input.ip}:24h`,
    now: input.now,
    windowMs: 24 * 60 * 60_000,
    windowExpiresOffsetMs: 24 * 60 * 60_000,
  });
  return ip24.count >= EMAIL_VERIFICATION_REQUEST_IP_LIMIT_24H;
}

export async function recordEmailVerificationRequestAttempt(
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
    scope: 'email_verification_request_email',
    subject: `email:${input.emailNormalized}:15m`,
    now: input.now,
    windowMs: 15 * 60_000,
    windowExpiresOffsetMs: 15 * 60_000,
  });
  await incrementWindow(db, {
    rateLimitHashKey: input.rateLimitHashKey,
    scope: 'email_verification_request_email',
    subject: `email:${input.emailNormalized}:24h`,
    now: input.now,
    windowMs: 24 * 60 * 60_000,
    windowExpiresOffsetMs: 24 * 60 * 60_000,
  });
  await incrementWindow(db, {
    rateLimitHashKey: input.rateLimitHashKey,
    scope: 'email_verification_request_ip',
    subject: `ip:${input.ip}:15m`,
    now: input.now,
    windowMs: 15 * 60_000,
    windowExpiresOffsetMs: 15 * 60_000,
  });
  await incrementWindow(db, {
    rateLimitHashKey: input.rateLimitHashKey,
    scope: 'email_verification_request_ip',
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
        purpose: 'verify_email',
        scope: 'email_verification_request',
      },
    });
  }
}

export async function isEmailVerificationAttemptThrottled(
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
    scope: 'email_verification_attempt_email_ip',
    subject: `email_ip:${input.emailNormalized}:${input.ip}:30m`,
    now: input.now,
    windowMs: 30 * 60_000,
    windowExpiresOffsetMs: 30 * 60_000,
  });
  if (emailIp.count >= EMAIL_VERIFICATION_ATTEMPT_EMAIL_IP_LIMIT_30M) {
    return true;
  }

  const challenge = await countInWindow(db, {
    rateLimitHashKey: input.rateLimitHashKey,
    scope: 'email_verification_attempt_challenge',
    subject: `challenge:${input.challengeId}`,
    now: input.now,
    windowMs: 24 * 60 * 60_000,
    windowExpiresOffsetMs: 24 * 60 * 60_000,
  });
  // Challenge attempt_count is authoritative for the 5-attempt limit; this bucket tracks abuse.
  return challenge.count >= 50;
}

export async function recordEmailVerificationFailedAttempt(
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
    scope: 'email_verification_attempt_email_ip',
    subject: `email_ip:${input.emailNormalized}:${input.ip}:30m`,
    now: input.now,
    windowMs: 30 * 60_000,
    windowExpiresOffsetMs: 30 * 60_000,
  });
  await incrementWindow(db, {
    rateLimitHashKey: input.rateLimitHashKey,
    scope: 'email_verification_attempt_challenge',
    subject: `challenge:${input.challengeId}`,
    now: input.now,
    windowMs: 24 * 60 * 60_000,
    windowExpiresOffsetMs: 24 * 60 * 60_000,
  });

  if (emailIpCount >= EMAIL_VERIFICATION_ATTEMPT_EMAIL_IP_LIMIT_30M) {
    await appendIdentitySecurityEvent(db, {
      id: randomUUID(),
      accountId: input.accountId ?? null,
      eventType: 'rate_limit_triggered',
      occurredAt: input.now,
      requestId: input.requestId ?? null,
      metadata: {
        purpose: 'verify_email',
        scope: 'email_verification_attempt_email_ip',
      },
    });
  }
}

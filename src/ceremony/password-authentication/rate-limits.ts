import { randomUUID } from 'node:crypto';
import type { Database } from '../../db/client.js';
import type { CeremonyRateLimitScope } from '../../db/schema.js';
import { appendIdentitySecurityEvent } from '../../identity/repositories/security-events.js';
import { hashRateLimitSubject } from '../email-verification/crypto.js';
import {
  getOrCreateCeremonyRateLimitBucket,
  incrementCeremonyRateLimit,
} from '../repositories/ceremony-rate-limits.js';
import { PASSWORD_SIGN_IN_EMAIL_LIMIT_30M, PASSWORD_SIGN_IN_IP_LIMIT_30M } from './policy.js';

type Db = Database['db'];

const WINDOW_MS = 30 * 60_000;

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
  },
): Promise<{ count: number; bucketId: string }> {
  const nowMs = new Date(input.now).getTime();
  const windowStartedAt = floorWindowStart(nowMs, WINDOW_MS).toISOString();
  const windowExpiresAt = new Date(new Date(windowStartedAt).getTime() + WINDOW_MS).toISOString();
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
  },
): Promise<number> {
  const { bucketId } = await countInWindow(db, input);
  const updated = await incrementCeremonyRateLimit(db, { id: bucketId, now: input.now });
  return updated.attemptCount;
}

export async function isPasswordSignInThrottled(
  db: Db,
  input: {
    rateLimitHashKey: string;
    emailNormalized: string;
    ip: string;
    now: string;
  },
): Promise<boolean> {
  const email = await countInWindow(db, {
    rateLimitHashKey: input.rateLimitHashKey,
    scope: 'password_sign_in_email',
    subject: `email:${input.emailNormalized}:30m`,
    now: input.now,
  });
  if (email.count >= PASSWORD_SIGN_IN_EMAIL_LIMIT_30M) {
    return true;
  }

  const ip = await countInWindow(db, {
    rateLimitHashKey: input.rateLimitHashKey,
    scope: 'password_sign_in_ip',
    subject: `ip:${input.ip}:30m`,
    now: input.now,
  });
  return ip.count >= PASSWORD_SIGN_IN_IP_LIMIT_30M;
}

export async function recordPasswordSignInAttempt(
  db: Db,
  input: {
    rateLimitHashKey: string;
    emailNormalized: string;
    ip: string;
    now: string;
    throttled: boolean;
    accountId?: string | null;
    requestId?: string | null;
    failureCategory?: string;
  },
): Promise<void> {
  const emailCount = await incrementWindow(db, {
    rateLimitHashKey: input.rateLimitHashKey,
    scope: 'password_sign_in_email',
    subject: `email:${input.emailNormalized}:30m`,
    now: input.now,
  });
  const ipCount = await incrementWindow(db, {
    rateLimitHashKey: input.rateLimitHashKey,
    scope: 'password_sign_in_ip',
    subject: `ip:${input.ip}:30m`,
    now: input.now,
  });

  if (
    input.throttled ||
    emailCount >= PASSWORD_SIGN_IN_EMAIL_LIMIT_30M ||
    ipCount >= PASSWORD_SIGN_IN_IP_LIMIT_30M
  ) {
    await appendIdentitySecurityEvent(db, {
      id: randomUUID(),
      accountId: input.accountId ?? null,
      eventType: 'rate_limit_triggered',
      occurredAt: input.now,
      requestId: input.requestId ?? null,
      metadata: {
        purpose: 'password_sign_in',
        scope: 'password_sign_in',
        ...(input.failureCategory !== undefined ? { failureCategory: input.failureCategory } : {}),
      },
    });
  }
}

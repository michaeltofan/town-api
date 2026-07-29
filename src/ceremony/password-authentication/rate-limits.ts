import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { ceremonyRateLimits, type CeremonyRateLimitScope } from '../../db/schema.js';
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

function passwordSignInIpWindow(now: string): {
  windowStartedAt: string;
  windowExpiresAt: string;
} {
  const nowMs = new Date(now).getTime();
  const windowStartedAt = floorWindowStart(nowMs, WINDOW_MS).toISOString();
  const windowExpiresAt = new Date(new Date(windowStartedAt).getTime() + WINDOW_MS).toISOString();
  return { windowStartedAt, windowExpiresAt };
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
  const { windowStartedAt, windowExpiresAt } = passwordSignInIpWindow(input.now);
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

export async function isPasswordSignInEmailThrottled(
  db: Db,
  input: {
    rateLimitHashKey: string;
    emailNormalized: string;
    now: string;
  },
): Promise<boolean> {
  const email = await countInWindow(db, {
    rateLimitHashKey: input.rateLimitHashKey,
    scope: 'password_sign_in_email',
    subject: `email:${input.emailNormalized}:30m`,
    now: input.now,
  });
  return email.count >= PASSWORD_SIGN_IN_EMAIL_LIMIT_30M;
}

export type PasswordSignInIpReservation =
  { status: 'reserved'; attemptCount: number } | { status: 'throttled'; attemptCount: number };

/**
 * Atomically consume one password-sign-in IP slot for the current window.
 *
 * Uses a single INSERT ... ON CONFLICT DO UPDATE ... WHERE attempt_count < limit
 * RETURNING attempt_count. Empty RETURNING means the window is already at the
 * limit (no increment). Completes before any Argon2 work and does not hold a
 * transaction open across verification.
 */
export async function reservePasswordSignInIpAttempt(
  db: Db,
  input: {
    rateLimitHashKey: string;
    ip: string;
    now: string;
    accountId?: string | null;
    requestId?: string | null;
    failureCategory?: string;
  },
): Promise<PasswordSignInIpReservation> {
  const { windowStartedAt, windowExpiresAt } = passwordSignInIpWindow(input.now);
  const subjectHash = hashRateLimitSubject({
    hashKey: input.rateLimitHashKey,
    scope: 'password_sign_in_ip',
    subject: `ip:${input.ip}:30m`,
  });

  let rows: { attemptCount: number }[];
  try {
    rows = await db
      .insert(ceremonyRateLimits)
      .values({
        id: randomUUID(),
        scope: 'password_sign_in_ip',
        subjectHash,
        windowStartedAt,
        windowExpiresAt,
        attemptCount: 1,
        blockedUntil: null,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoUpdate({
        target: [
          ceremonyRateLimits.scope,
          ceremonyRateLimits.subjectHash,
          ceremonyRateLimits.windowStartedAt,
        ],
        set: {
          attemptCount: sql`${ceremonyRateLimits.attemptCount} + 1`,
          updatedAt: input.now,
        },
        setWhere: sql`${ceremonyRateLimits.attemptCount} < ${PASSWORD_SIGN_IN_IP_LIMIT_30M}`,
      })
      .returning({ attemptCount: ceremonyRateLimits.attemptCount });
  } catch {
    // Fail closed: treat reservation failure as throttled without Argon2 work.
    await maybeEmitRateLimitTriggered(db, {
      throttled: true,
      crossedLimit: true,
      now: input.now,
      ...(input.accountId !== undefined ? { accountId: input.accountId } : {}),
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      failureCategory: input.failureCategory ?? 'rate_limited',
    }).catch(() => undefined);
    return { status: 'throttled', attemptCount: PASSWORD_SIGN_IN_IP_LIMIT_30M };
  }

  const attemptCount = rows[0]?.attemptCount;
  if (attemptCount === undefined) {
    await maybeEmitRateLimitTriggered(db, {
      throttled: true,
      crossedLimit: true,
      now: input.now,
      ...(input.accountId !== undefined ? { accountId: input.accountId } : {}),
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      failureCategory: input.failureCategory ?? 'rate_limited',
    });
    return { status: 'throttled', attemptCount: PASSWORD_SIGN_IN_IP_LIMIT_30M };
  }

  if (attemptCount >= PASSWORD_SIGN_IN_IP_LIMIT_30M) {
    await maybeEmitRateLimitTriggered(db, {
      throttled: false,
      crossedLimit: true,
      now: input.now,
      ...(input.accountId !== undefined ? { accountId: input.accountId } : {}),
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      ...(input.failureCategory !== undefined ? { failureCategory: input.failureCategory } : {}),
    });
  }

  return { status: 'reserved', attemptCount };
}

async function maybeEmitRateLimitTriggered(
  db: Db,
  input: {
    throttled: boolean;
    crossedLimit: boolean;
    now: string;
    accountId?: string | null;
    requestId?: string | null;
    failureCategory?: string;
  },
): Promise<void> {
  if (!input.throttled && !input.crossedLimit) {
    return;
  }
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

/**
 * Record only the normalized-email subject. IP slots are reserved before Argon2
 * and must not be incremented again for the same request.
 */
export async function recordPasswordSignInEmailAttempt(
  db: Db,
  input: {
    rateLimitHashKey: string;
    emailNormalized: string;
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

  await maybeEmitRateLimitTriggered(db, {
    throttled: input.throttled,
    crossedLimit: emailCount >= PASSWORD_SIGN_IN_EMAIL_LIMIT_30M,
    now: input.now,
    ...(input.accountId !== undefined ? { accountId: input.accountId } : {}),
    ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
    ...(input.failureCategory !== undefined ? { failureCategory: input.failureCategory } : {}),
  });
}

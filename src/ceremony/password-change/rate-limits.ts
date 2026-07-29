import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { ceremonyRateLimits } from '../../db/schema.js';
import { appendIdentitySecurityEvent } from '../../identity/repositories/security-events.js';
import { hashRateLimitSubject } from '../email-verification/crypto.js';
import { PASSWORD_CHANGE_ACCOUNT_LIMIT_30M } from './policy.js';

type Db = Database['db'];

const WINDOW_MS = 30 * 60_000;

function floorWindowStart(nowMs: number, windowMs: number): Date {
  return new Date(Math.floor(nowMs / windowMs) * windowMs);
}

function passwordChangeAccountWindow(now: string): {
  windowStartedAt: string;
  windowExpiresAt: string;
} {
  const nowMs = new Date(now).getTime();
  const windowStartedAt = floorWindowStart(nowMs, WINDOW_MS).toISOString();
  const windowExpiresAt = new Date(new Date(windowStartedAt).getTime() + WINDOW_MS).toISOString();
  return { windowStartedAt, windowExpiresAt };
}

export type PasswordChangeAccountReservation =
  { status: 'reserved'; attemptCount: number } | { status: 'throttled'; attemptCount: number };

/**
 * Atomically consume one password-change account slot for the current window.
 *
 * Uses a single INSERT ... ON CONFLICT DO UPDATE ... WHERE attempt_count < limit
 * RETURNING attempt_count. Empty RETURNING means the window is already at the
 * limit (no increment). Completes before any Argon2 work and does not hold a
 * transaction open across verification.
 */
export async function reservePasswordChangeAccountAttempt(
  db: Db,
  input: {
    rateLimitHashKey: string;
    accountId: string;
    now: string;
    requestId?: string | null;
    failureCategory?: string;
  },
): Promise<PasswordChangeAccountReservation> {
  const { windowStartedAt, windowExpiresAt } = passwordChangeAccountWindow(input.now);
  const subjectHash = hashRateLimitSubject({
    hashKey: input.rateLimitHashKey,
    scope: 'password_change_account',
    subject: `account:${input.accountId}:30m`,
  });

  let rows: { attemptCount: number }[];
  try {
    rows = await db
      .insert(ceremonyRateLimits)
      .values({
        id: randomUUID(),
        scope: 'password_change_account',
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
        setWhere: sql`${ceremonyRateLimits.attemptCount} < ${PASSWORD_CHANGE_ACCOUNT_LIMIT_30M}`,
      })
      .returning({ attemptCount: ceremonyRateLimits.attemptCount });
  } catch {
    // Fail closed: treat reservation failure as throttled without Argon2 work.
    await maybeEmitRateLimitTriggered(db, {
      throttled: true,
      crossedLimit: true,
      now: input.now,
      accountId: input.accountId,
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      failureCategory: input.failureCategory ?? 'rate_limited',
    }).catch(() => undefined);
    return { status: 'throttled', attemptCount: PASSWORD_CHANGE_ACCOUNT_LIMIT_30M };
  }

  const attemptCount = rows[0]?.attemptCount;
  if (attemptCount === undefined) {
    await maybeEmitRateLimitTriggered(db, {
      throttled: true,
      crossedLimit: true,
      now: input.now,
      accountId: input.accountId,
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      failureCategory: input.failureCategory ?? 'rate_limited',
    });
    return { status: 'throttled', attemptCount: PASSWORD_CHANGE_ACCOUNT_LIMIT_30M };
  }

  if (attemptCount >= PASSWORD_CHANGE_ACCOUNT_LIMIT_30M) {
    await maybeEmitRateLimitTriggered(db, {
      throttled: false,
      crossedLimit: true,
      now: input.now,
      accountId: input.accountId,
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
    accountId: string;
    requestId?: string | null;
    failureCategory?: string;
  },
): Promise<void> {
  if (!input.throttled && !input.crossedLimit) {
    return;
  }
  await appendIdentitySecurityEvent(db, {
    id: randomUUID(),
    accountId: input.accountId,
    eventType: 'rate_limit_triggered',
    occurredAt: input.now,
    requestId: input.requestId ?? null,
    metadata: {
      purpose: 'password_change',
      scope: 'password_change_account',
      ...(input.failureCategory !== undefined ? { failureCategory: input.failureCategory } : {}),
    },
  });
}

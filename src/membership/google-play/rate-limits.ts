import { randomUUID } from 'node:crypto';
import type { Database } from '../../db/client.js';
import { hashRateLimitSubject } from '../../ceremony/email-verification/crypto.js';
import {
  getOrCreateCeremonyRateLimitBucket,
  incrementCeremonyRateLimit,
} from '../../ceremony/repositories/ceremony-rate-limits.js';
import { appendIdentitySecurityEvent } from '../../identity/repositories/security-events.js';

type Db = Database['db'];

const WINDOW_30M_MS = 30 * 60_000;
export const GOOGLE_PLAY_PURCHASE_ACCOUNT_LIMIT_30M = 10;

/**
 * Reuses approved scope `billing_checkout_account` with a distinct subject prefix
 * so Google Play purchase buckets stay separate without a ceremony_rate_limits
 * CHECK-constraint migration.
 */
const GOOGLE_PLAY_PURCHASE_SUBJECT_PREFIX = 'google_play_purchase:';

function floorWindowStart(nowMs: number, windowMs: number): Date {
  return new Date(Math.floor(nowMs / windowMs) * windowMs);
}

async function countInWindow(
  db: Db,
  input: {
    rateLimitHashKey: string;
    accountId: string;
    now: string;
  },
): Promise<{ count: number; bucketId: string }> {
  const nowMs = new Date(input.now).getTime();
  const windowStartedAt = floorWindowStart(nowMs, WINDOW_30M_MS).toISOString();
  const windowExpiresAt = new Date(
    new Date(windowStartedAt).getTime() + WINDOW_30M_MS,
  ).toISOString();
  const subjectHash = hashRateLimitSubject({
    hashKey: input.rateLimitHashKey,
    scope: 'billing_checkout_account',
    subject: `${GOOGLE_PLAY_PURCHASE_SUBJECT_PREFIX}${input.accountId}`,
  });
  const bucket = await getOrCreateCeremonyRateLimitBucket(db, {
    id: randomUUID(),
    scope: 'billing_checkout_account',
    subjectHash,
    windowStartedAt,
    windowExpiresAt,
    createdAt: input.now,
  });
  return { count: bucket.attemptCount, bucketId: bucket.id };
}

export async function isGooglePlayPurchaseThrottled(
  db: Db,
  input: { rateLimitHashKey: string; accountId: string; now: string },
): Promise<boolean> {
  const { count } = await countInWindow(db, input);
  return count >= GOOGLE_PLAY_PURCHASE_ACCOUNT_LIMIT_30M;
}

export async function recordGooglePlayPurchaseAttempt(
  db: Db,
  input: {
    rateLimitHashKey: string;
    accountId: string;
    now: string;
    throttled: boolean;
    requestId?: string | null;
  },
): Promise<number> {
  const { bucketId, count: before } = await countInWindow(db, input);
  const updated = await incrementCeremonyRateLimit(db, { id: bucketId, now: input.now });
  if (input.throttled || updated.attemptCount >= GOOGLE_PLAY_PURCHASE_ACCOUNT_LIMIT_30M) {
    await appendIdentitySecurityEvent(db, {
      id: randomUUID(),
      accountId: input.accountId,
      eventType: 'rate_limit_triggered',
      occurredAt: input.now,
      requestId: input.requestId ?? null,
      metadata: {
        scope: 'billing_checkout_account',
        purpose: 'google_play_purchase',
      },
    });
  }
  return before + 1;
}

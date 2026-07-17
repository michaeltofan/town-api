import { randomUUID } from 'node:crypto';
import type { Database } from '../db/client.js';
import { hashRateLimitSubject } from '../ceremony/email-verification/crypto.js';
import {
  getOrCreateCeremonyRateLimitBucket,
  incrementCeremonyRateLimit,
} from '../ceremony/repositories/ceremony-rate-limits.js';
import { appendIdentitySecurityEvent } from '../identity/repositories/security-events.js';

type Db = Database['db'];

const WINDOW_15M_MS = 15 * 60_000;
export const MEMBERSHIP_INVENTORY_ACCOUNT_LIMIT_15M = 60;

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
  const windowStartedAt = floorWindowStart(nowMs, WINDOW_15M_MS).toISOString();
  const windowExpiresAt = new Date(
    new Date(windowStartedAt).getTime() + WINDOW_15M_MS,
  ).toISOString();
  const subjectHash = hashRateLimitSubject({
    hashKey: input.rateLimitHashKey,
    scope: 'membership_inventory_account',
    subject: `account:${input.accountId}`,
  });
  const bucket = await getOrCreateCeremonyRateLimitBucket(db, {
    id: randomUUID(),
    scope: 'membership_inventory_account',
    subjectHash,
    windowStartedAt,
    windowExpiresAt,
    createdAt: input.now,
  });
  return { count: bucket.attemptCount, bucketId: bucket.id };
}

export async function isMembershipInventoryThrottled(
  db: Db,
  input: { rateLimitHashKey: string; accountId: string; now: string },
): Promise<boolean> {
  const bucket = await countInWindow(db, input);
  return bucket.count >= MEMBERSHIP_INVENTORY_ACCOUNT_LIMIT_15M;
}

export async function recordMembershipInventoryAttempt(
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
  if (input.throttled || updated.attemptCount >= MEMBERSHIP_INVENTORY_ACCOUNT_LIMIT_15M) {
    await appendIdentitySecurityEvent(db, {
      id: randomUUID(),
      accountId: input.accountId,
      eventType: 'rate_limit_triggered',
      occurredAt: input.now,
      requestId: input.requestId ?? null,
      metadata: {
        scope: 'membership_inventory_account',
        purpose: 'membership_inventory',
      },
    });
  }
  return before + 1;
}

import { randomUUID } from 'node:crypto';
import type { Database } from '../db/client.js';
import { hashRateLimitSubject } from '../ceremony/email-verification/crypto.js';
import {
  getOrCreateCeremonyRateLimitBucket,
  incrementCeremonyRateLimit,
} from '../ceremony/repositories/ceremony-rate-limits.js';
import type { CeremonyRateLimitScope } from '../db/schema.js';
import { appendIdentitySecurityEvent } from '../identity/repositories/security-events.js';

type Db = Database['db'];

const WINDOW_30M_MS = 30 * 60_000;

export const BILLING_CHECKOUT_ACCOUNT_LIMIT_30M = 5;
export const BILLING_PORTAL_ACCOUNT_LIMIT_30M = 10;

function floorWindowStart(nowMs: number, windowMs: number): Date {
  return new Date(Math.floor(nowMs / windowMs) * windowMs);
}

type BillingScope = Extract<
  CeremonyRateLimitScope,
  'billing_checkout_account' | 'billing_portal_account'
>;

async function countInWindow(
  db: Db,
  input: {
    rateLimitHashKey: string;
    accountId: string;
    scope: BillingScope;
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
    scope: input.scope,
    subject: `account:${input.accountId}`,
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

export async function isBillingCheckoutThrottled(
  db: Db,
  input: { rateLimitHashKey: string; accountId: string; now: string },
): Promise<boolean> {
  const { count } = await countInWindow(db, { ...input, scope: 'billing_checkout_account' });
  return count >= BILLING_CHECKOUT_ACCOUNT_LIMIT_30M;
}

export async function recordBillingCheckoutAttempt(
  db: Db,
  input: {
    rateLimitHashKey: string;
    accountId: string;
    now: string;
    throttled: boolean;
    requestId?: string | null;
  },
): Promise<number> {
  const { bucketId, count: before } = await countInWindow(db, {
    ...input,
    scope: 'billing_checkout_account',
  });
  const updated = await incrementCeremonyRateLimit(db, { id: bucketId, now: input.now });
  if (input.throttled || updated.attemptCount >= BILLING_CHECKOUT_ACCOUNT_LIMIT_30M) {
    await appendIdentitySecurityEvent(db, {
      id: randomUUID(),
      accountId: input.accountId,
      eventType: 'rate_limit_triggered',
      occurredAt: input.now,
      requestId: input.requestId ?? null,
      metadata: {
        scope: 'billing_checkout_account',
        purpose: 'billing_checkout',
      },
    });
  }
  return before + 1;
}

export async function isBillingPortalThrottled(
  db: Db,
  input: { rateLimitHashKey: string; accountId: string; now: string },
): Promise<boolean> {
  const { count } = await countInWindow(db, { ...input, scope: 'billing_portal_account' });
  return count >= BILLING_PORTAL_ACCOUNT_LIMIT_30M;
}

export async function recordBillingPortalAttempt(
  db: Db,
  input: {
    rateLimitHashKey: string;
    accountId: string;
    now: string;
    throttled: boolean;
    requestId?: string | null;
  },
): Promise<number> {
  const { bucketId, count: before } = await countInWindow(db, {
    ...input,
    scope: 'billing_portal_account',
  });
  const updated = await incrementCeremonyRateLimit(db, { id: bucketId, now: input.now });
  if (input.throttled || updated.attemptCount >= BILLING_PORTAL_ACCOUNT_LIMIT_30M) {
    await appendIdentitySecurityEvent(db, {
      id: randomUUID(),
      accountId: input.accountId,
      eventType: 'rate_limit_triggered',
      occurredAt: input.now,
      requestId: input.requestId ?? null,
      metadata: {
        scope: 'billing_portal_account',
        purpose: 'billing_portal',
      },
    });
  }
  return before + 1;
}

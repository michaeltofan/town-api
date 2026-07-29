import { randomUUID } from 'node:crypto';
import type { Database } from '../../db/client.js';
import type { CeremonyRateLimitScope } from '../../db/schema.js';
import { appendIdentitySecurityEvent } from '../../identity/repositories/security-events.js';
import {
  getOrCreateCeremonyRateLimitBucket,
  incrementCeremonyRateLimit,
} from '../repositories/ceremony-rate-limits.js';
import { hashRateLimitSubject } from '../email-verification/crypto.js';
import { PASSWORD_SETUP_GRANT_LIMIT } from './policy.js';

type Db = Database['db'];

const GRANT_WINDOW_MS = 24 * 60 * 60_000;

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
  const windowStartedAt = new Date(
    Math.floor(nowMs / GRANT_WINDOW_MS) * GRANT_WINDOW_MS,
  ).toISOString();
  const windowExpiresAt = new Date(
    new Date(windowStartedAt).getTime() + GRANT_WINDOW_MS,
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
  },
): Promise<number> {
  const { bucketId } = await countInWindow(db, input);
  const updated = await incrementCeremonyRateLimit(db, { id: bucketId, now: input.now });
  return updated.attemptCount;
}

export async function isPasswordSetupGrantThrottled(
  db: Db,
  input: { rateLimitHashKey: string; grantId: string; now: string },
): Promise<boolean> {
  const bucket = await countInWindow(db, {
    rateLimitHashKey: input.rateLimitHashKey,
    scope: 'password_setup_grant',
    subject: `grant:${input.grantId}`,
    now: input.now,
  });
  return bucket.count >= PASSWORD_SETUP_GRANT_LIMIT;
}

export async function recordPasswordSetupGrantAttempt(
  db: Db,
  input: {
    rateLimitHashKey: string;
    grantId: string;
    accountId: string | null;
    now: string;
    throttled: boolean;
    requestId?: string | null;
    failureCategory?: string;
  },
): Promise<number> {
  const count = await incrementWindow(db, {
    rateLimitHashKey: input.rateLimitHashKey,
    scope: 'password_setup_grant',
    subject: `grant:${input.grantId}`,
    now: input.now,
  });
  if (input.throttled || count >= PASSWORD_SETUP_GRANT_LIMIT) {
    await appendIdentitySecurityEvent(db, {
      id: randomUUID(),
      accountId: input.accountId,
      eventType: 'rate_limit_triggered',
      occurredAt: input.now,
      requestId: input.requestId ?? null,
      metadata: {
        purpose: 'initial_password_setup',
        scope: 'password_setup_grant',
        ...(input.failureCategory !== undefined
          ? { failureCategory: input.failureCategory }
          : {}),
      },
    });
  }
  return count;
}

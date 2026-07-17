import { randomUUID } from 'node:crypto';
import type { Database } from '../../db/client.js';
import type { CeremonyRateLimitScope } from '../../db/schema.js';
import { appendIdentitySecurityEvent } from '../../identity/repositories/security-events.js';
import { hashRateLimitSubject } from '../email-verification/crypto.js';
import {
  getOrCreateCeremonyRateLimitBucket,
  incrementCeremonyRateLimit,
} from '../repositories/ceremony-rate-limits.js';
import {
  ASSERTION_CREDENTIAL_LIMIT_30M,
  ASSERTION_IP_LIMIT_30M,
  OPTIONS_CLIENT_LIMIT_15M,
  OPTIONS_IP_LIMIT_15M,
  OPTIONS_IP_LIMIT_24H,
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
  },
): Promise<{ count: number; bucketId: string }> {
  const nowMs = new Date(input.now).getTime();
  const windowStartedAt = floorWindowStart(nowMs, input.windowMs).toISOString();
  const windowExpiresAt = new Date(
    new Date(windowStartedAt).getTime() + input.windowMs,
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
  },
): Promise<number> {
  const { bucketId } = await countInWindow(db, input);
  const updated = await incrementCeremonyRateLimit(db, { id: bucketId, now: input.now });
  return updated.attemptCount;
}

export async function isPasskeyOptionsThrottled(
  db: Db,
  input: { rateLimitHashKey: string; ip: string; anonymousClientKey: string; now: string },
): Promise<boolean> {
  const ip15 = await countInWindow(db, {
    rateLimitHashKey: input.rateLimitHashKey,
    scope: 'passkey_options_ip',
    subject: `ip:${input.ip}:15m`,
    now: input.now,
    windowMs: 15 * 60_000,
  });
  if (ip15.count >= OPTIONS_IP_LIMIT_15M) {
    return true;
  }
  const ip24 = await countInWindow(db, {
    rateLimitHashKey: input.rateLimitHashKey,
    scope: 'passkey_options_ip',
    subject: `ip:${input.ip}:24h`,
    now: input.now,
    windowMs: 24 * 60 * 60_000,
  });
  if (ip24.count >= OPTIONS_IP_LIMIT_24H) {
    return true;
  }
  const client = await countInWindow(db, {
    rateLimitHashKey: input.rateLimitHashKey,
    scope: 'passkey_options_client',
    subject: `client:${input.anonymousClientKey}:15m`,
    now: input.now,
    windowMs: 15 * 60_000,
  });
  return client.count >= OPTIONS_CLIENT_LIMIT_15M;
}

export async function recordPasskeyOptionsAttempt(
  db: Db,
  input: {
    rateLimitHashKey: string;
    ip: string;
    anonymousClientKey: string;
    now: string;
    throttled: boolean;
    requestId?: string | null;
  },
): Promise<void> {
  await incrementWindow(db, {
    rateLimitHashKey: input.rateLimitHashKey,
    scope: 'passkey_options_ip',
    subject: `ip:${input.ip}:15m`,
    now: input.now,
    windowMs: 15 * 60_000,
  });
  await incrementWindow(db, {
    rateLimitHashKey: input.rateLimitHashKey,
    scope: 'passkey_options_ip',
    subject: `ip:${input.ip}:24h`,
    now: input.now,
    windowMs: 24 * 60 * 60_000,
  });
  await incrementWindow(db, {
    rateLimitHashKey: input.rateLimitHashKey,
    scope: 'passkey_options_client',
    subject: `client:${input.anonymousClientKey}:15m`,
    now: input.now,
    windowMs: 15 * 60_000,
  });
  if (input.throttled) {
    await appendIdentitySecurityEvent(db, {
      id: randomUUID(),
      accountId: null,
      eventType: 'rate_limit_triggered',
      occurredAt: input.now,
      requestId: input.requestId ?? null,
      metadata: { purpose: 'authenticate', scope: 'passkey_options' },
    });
  }
}

export async function isPasskeyAssertionThrottled(
  db: Db,
  input: {
    rateLimitHashKey: string;
    ip: string;
    credentialSubject: string;
    now: string;
  },
): Promise<boolean> {
  const credential = await countInWindow(db, {
    rateLimitHashKey: input.rateLimitHashKey,
    scope: 'passkey_assertion_credential',
    subject: `credential:${input.credentialSubject}:30m`,
    now: input.now,
    windowMs: 30 * 60_000,
  });
  if (credential.count >= ASSERTION_CREDENTIAL_LIMIT_30M) {
    return true;
  }
  const ip = await countInWindow(db, {
    rateLimitHashKey: input.rateLimitHashKey,
    scope: 'passkey_assertion_ip',
    subject: `ip:${input.ip}:30m`,
    now: input.now,
    windowMs: 30 * 60_000,
  });
  return ip.count >= ASSERTION_IP_LIMIT_30M;
}

export async function recordPasskeyAssertionFailedAttempt(
  db: Db,
  input: {
    rateLimitHashKey: string;
    ip: string;
    credentialSubject: string;
    accountId: string | null;
    now: string;
    requestId?: string | null;
    failureCategory: string;
  },
): Promise<void> {
  const credentialCount = await incrementWindow(db, {
    rateLimitHashKey: input.rateLimitHashKey,
    scope: 'passkey_assertion_credential',
    subject: `credential:${input.credentialSubject}:30m`,
    now: input.now,
    windowMs: 30 * 60_000,
  });
  const ipCount = await incrementWindow(db, {
    rateLimitHashKey: input.rateLimitHashKey,
    scope: 'passkey_assertion_ip',
    subject: `ip:${input.ip}:30m`,
    now: input.now,
    windowMs: 30 * 60_000,
  });
  if (credentialCount >= ASSERTION_CREDENTIAL_LIMIT_30M || ipCount >= ASSERTION_IP_LIMIT_30M) {
    await appendIdentitySecurityEvent(db, {
      id: randomUUID(),
      accountId: input.accountId,
      eventType: 'rate_limit_triggered',
      occurredAt: input.now,
      requestId: input.requestId ?? null,
      metadata: {
        purpose: 'authenticate',
        scope: 'passkey_assertion',
        failureCategory: input.failureCategory,
      },
    });
  }
}

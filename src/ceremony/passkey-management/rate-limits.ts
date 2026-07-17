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
  PASSKEY_INVENTORY_ACCOUNT_LIMIT_15M,
  PASSKEY_REAUTHENTICATION_OPTIONS_SESSION_LIMIT_15M,
  PASSKEY_REAUTHENTICATION_VERIFY_SESSION_LIMIT_15M,
  PASSKEY_REGISTRATION_OPTIONS_SESSION_LIMIT_15M,
  PASSKEY_REGISTRATION_VERIFY_SESSION_LIMIT_15M,
  PASSKEY_RENAME_ACCOUNT_LIMIT_24H,
  PASSKEY_REVOKE_ACCOUNT_LIMIT_24H,
} from './policy.js';

type Db = Database['db'];

const WINDOW_15M_MS = 15 * 60_000;
const WINDOW_24H_MS = 24 * 60 * 60_000;

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

async function isThrottled(
  db: Db,
  input: {
    rateLimitHashKey: string;
    scope: CeremonyRateLimitScope;
    subject: string;
    now: string;
    windowMs: number;
    limit: number;
  },
): Promise<boolean> {
  const bucket = await countInWindow(db, input);
  return bucket.count >= input.limit;
}

async function recordAttempt(
  db: Db,
  input: {
    rateLimitHashKey: string;
    scope: CeremonyRateLimitScope;
    subject: string;
    accountId: string;
    now: string;
    windowMs: number;
    limit: number;
    throttled: boolean;
    requestId?: string | null;
    purpose?: string;
  },
): Promise<number> {
  const count = await incrementWindow(db, {
    rateLimitHashKey: input.rateLimitHashKey,
    scope: input.scope,
    subject: input.subject,
    now: input.now,
    windowMs: input.windowMs,
  });
  if (input.throttled || count >= input.limit) {
    await appendIdentitySecurityEvent(db, {
      id: randomUUID(),
      accountId: input.accountId,
      eventType: 'rate_limit_triggered',
      occurredAt: input.now,
      requestId: input.requestId ?? null,
      metadata: {
        scope: input.scope,
        ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
      },
    });
  }
  return count;
}

export async function isPasskeyInventoryThrottled(
  db: Db,
  input: { rateLimitHashKey: string; accountId: string; now: string },
): Promise<boolean> {
  return isThrottled(db, {
    rateLimitHashKey: input.rateLimitHashKey,
    scope: 'passkey_inventory_account',
    subject: `account:${input.accountId}`,
    now: input.now,
    windowMs: WINDOW_15M_MS,
    limit: PASSKEY_INVENTORY_ACCOUNT_LIMIT_15M,
  });
}

export async function recordPasskeyInventoryAttempt(
  db: Db,
  input: {
    rateLimitHashKey: string;
    accountId: string;
    now: string;
    throttled: boolean;
    requestId?: string | null;
  },
): Promise<number> {
  return recordAttempt(db, {
    rateLimitHashKey: input.rateLimitHashKey,
    scope: 'passkey_inventory_account',
    subject: `account:${input.accountId}`,
    accountId: input.accountId,
    now: input.now,
    windowMs: WINDOW_15M_MS,
    limit: PASSKEY_INVENTORY_ACCOUNT_LIMIT_15M,
    throttled: input.throttled,
    purpose: 'passkey_inventory',
    ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
  });
}

export async function isManageReauthOptionsThrottled(
  db: Db,
  input: { rateLimitHashKey: string; sessionId: string; now: string },
): Promise<boolean> {
  return isThrottled(db, {
    rateLimitHashKey: input.rateLimitHashKey,
    scope: 'passkey_reauthentication_options_session',
    subject: `session:${input.sessionId}`,
    now: input.now,
    windowMs: WINDOW_15M_MS,
    limit: PASSKEY_REAUTHENTICATION_OPTIONS_SESSION_LIMIT_15M,
  });
}

export async function recordManageReauthOptionsAttempt(
  db: Db,
  input: {
    rateLimitHashKey: string;
    accountId: string;
    sessionId: string;
    now: string;
    throttled: boolean;
    requestId?: string | null;
  },
): Promise<number> {
  return recordAttempt(db, {
    rateLimitHashKey: input.rateLimitHashKey,
    scope: 'passkey_reauthentication_options_session',
    subject: `session:${input.sessionId}`,
    accountId: input.accountId,
    now: input.now,
    windowMs: WINDOW_15M_MS,
    limit: PASSKEY_REAUTHENTICATION_OPTIONS_SESSION_LIMIT_15M,
    throttled: input.throttled,
    purpose: 'manage_passkeys_authenticate',
    ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
  });
}

export async function isManageReauthVerifyThrottled(
  db: Db,
  input: { rateLimitHashKey: string; sessionId: string; now: string },
): Promise<boolean> {
  return isThrottled(db, {
    rateLimitHashKey: input.rateLimitHashKey,
    scope: 'passkey_reauthentication_verify_session',
    subject: `session:${input.sessionId}`,
    now: input.now,
    windowMs: WINDOW_15M_MS,
    limit: PASSKEY_REAUTHENTICATION_VERIFY_SESSION_LIMIT_15M,
  });
}

export async function recordManageReauthVerifyFailedAttempt(
  db: Db,
  input: {
    rateLimitHashKey: string;
    accountId: string;
    sessionId: string;
    now: string;
    requestId?: string | null;
    failureCategory: string;
  },
): Promise<number> {
  const count = await incrementWindow(db, {
    rateLimitHashKey: input.rateLimitHashKey,
    scope: 'passkey_reauthentication_verify_session',
    subject: `session:${input.sessionId}`,
    now: input.now,
    windowMs: WINDOW_15M_MS,
  });
  if (count >= PASSKEY_REAUTHENTICATION_VERIFY_SESSION_LIMIT_15M) {
    await appendIdentitySecurityEvent(db, {
      id: randomUUID(),
      accountId: input.accountId,
      eventType: 'rate_limit_triggered',
      occurredAt: input.now,
      requestId: input.requestId ?? null,
      metadata: {
        scope: 'passkey_reauthentication_verify_session',
        purpose: 'manage_passkeys_authenticate',
        failureCategory: input.failureCategory,
      },
    });
  }
  return count;
}

export async function isManageRegisterOptionsThrottled(
  db: Db,
  input: { rateLimitHashKey: string; sessionId: string; now: string },
): Promise<boolean> {
  return isThrottled(db, {
    rateLimitHashKey: input.rateLimitHashKey,
    scope: 'passkey_registration_options_session',
    subject: `session:${input.sessionId}`,
    now: input.now,
    windowMs: WINDOW_15M_MS,
    limit: PASSKEY_REGISTRATION_OPTIONS_SESSION_LIMIT_15M,
  });
}

export async function recordManageRegisterOptionsAttempt(
  db: Db,
  input: {
    rateLimitHashKey: string;
    accountId: string;
    sessionId: string;
    now: string;
    throttled: boolean;
    requestId?: string | null;
  },
): Promise<number> {
  return recordAttempt(db, {
    rateLimitHashKey: input.rateLimitHashKey,
    scope: 'passkey_registration_options_session',
    subject: `session:${input.sessionId}`,
    accountId: input.accountId,
    now: input.now,
    windowMs: WINDOW_15M_MS,
    limit: PASSKEY_REGISTRATION_OPTIONS_SESSION_LIMIT_15M,
    throttled: input.throttled,
    purpose: 'manage_passkeys_register',
    ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
  });
}

export async function isManageRegisterVerifyThrottled(
  db: Db,
  input: { rateLimitHashKey: string; sessionId: string; now: string },
): Promise<boolean> {
  return isThrottled(db, {
    rateLimitHashKey: input.rateLimitHashKey,
    scope: 'passkey_registration_verify_session',
    subject: `session:${input.sessionId}`,
    now: input.now,
    windowMs: WINDOW_15M_MS,
    limit: PASSKEY_REGISTRATION_VERIFY_SESSION_LIMIT_15M,
  });
}

export async function recordManageRegisterVerifyFailedAttempt(
  db: Db,
  input: {
    rateLimitHashKey: string;
    accountId: string;
    sessionId: string;
    now: string;
    requestId?: string | null;
    failureCategory: string;
  },
): Promise<number> {
  const count = await incrementWindow(db, {
    rateLimitHashKey: input.rateLimitHashKey,
    scope: 'passkey_registration_verify_session',
    subject: `session:${input.sessionId}`,
    now: input.now,
    windowMs: WINDOW_15M_MS,
  });
  if (count >= PASSKEY_REGISTRATION_VERIFY_SESSION_LIMIT_15M) {
    await appendIdentitySecurityEvent(db, {
      id: randomUUID(),
      accountId: input.accountId,
      eventType: 'rate_limit_triggered',
      occurredAt: input.now,
      requestId: input.requestId ?? null,
      metadata: {
        scope: 'passkey_registration_verify_session',
        purpose: 'manage_passkeys_register',
        failureCategory: input.failureCategory,
      },
    });
  }
  return count;
}

export async function isPasskeyRenameThrottled(
  db: Db,
  input: { rateLimitHashKey: string; accountId: string; now: string },
): Promise<boolean> {
  return isThrottled(db, {
    rateLimitHashKey: input.rateLimitHashKey,
    scope: 'passkey_rename_account',
    subject: `account:${input.accountId}`,
    now: input.now,
    windowMs: WINDOW_24H_MS,
    limit: PASSKEY_RENAME_ACCOUNT_LIMIT_24H,
  });
}

export async function recordPasskeyRenameAttempt(
  db: Db,
  input: {
    rateLimitHashKey: string;
    accountId: string;
    now: string;
    throttled: boolean;
    requestId?: string | null;
  },
): Promise<number> {
  return recordAttempt(db, {
    rateLimitHashKey: input.rateLimitHashKey,
    scope: 'passkey_rename_account',
    subject: `account:${input.accountId}`,
    accountId: input.accountId,
    now: input.now,
    windowMs: WINDOW_24H_MS,
    limit: PASSKEY_RENAME_ACCOUNT_LIMIT_24H,
    throttled: input.throttled,
    purpose: 'passkey_rename',
    ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
  });
}

export async function isPasskeyRevokeThrottled(
  db: Db,
  input: { rateLimitHashKey: string; accountId: string; now: string },
): Promise<boolean> {
  return isThrottled(db, {
    rateLimitHashKey: input.rateLimitHashKey,
    scope: 'passkey_revoke_account',
    subject: `account:${input.accountId}`,
    now: input.now,
    windowMs: WINDOW_24H_MS,
    limit: PASSKEY_REVOKE_ACCOUNT_LIMIT_24H,
  });
}

export async function recordPasskeyRevokeAttempt(
  db: Db,
  input: {
    rateLimitHashKey: string;
    accountId: string;
    now: string;
    throttled: boolean;
    requestId?: string | null;
  },
): Promise<number> {
  return recordAttempt(db, {
    rateLimitHashKey: input.rateLimitHashKey,
    scope: 'passkey_revoke_account',
    subject: `account:${input.accountId}`,
    accountId: input.accountId,
    now: input.now,
    windowMs: WINDOW_24H_MS,
    limit: PASSKEY_REVOKE_ACCOUNT_LIMIT_24H,
    throttled: input.throttled,
    purpose: 'passkey_revoke',
    ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
  });
}

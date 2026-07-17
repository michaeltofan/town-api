import { and, eq, gt, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  ceremonyRateLimits,
  type CeremonyRateLimitRow,
  type CeremonyRateLimitScope,
} from '../../db/schema.js';
import { assertHashedBytes } from '../../identity/hashing.js';
import { CeremonyInvariantError } from '../errors.js';

type Db = Database['db'];

const APPROVED_SCOPES = new Set<CeremonyRateLimitScope>([
  'email_verification_request_email',
  'email_verification_request_ip',
  'email_verification_attempt_challenge',
  'email_verification_attempt_email_ip',
  'passkey_options_ip',
  'passkey_options_client',
  'passkey_assertion_credential',
  'passkey_assertion_ip',
  'recovery_request_email',
  'recovery_request_ip',
  'setup_options_grant',
  'setup_verification_grant',
  'recovery_options_grant',
  'recovery_verification_grant',
  'recovery_email_attempt_challenge',
  'recovery_email_attempt_email_ip',
]);

function assertApprovedScope(scope: CeremonyRateLimitScope): CeremonyRateLimitScope {
  if (!APPROVED_SCOPES.has(scope)) {
    throw new CeremonyInvariantError(
      'INVALID_RATE_LIMIT_SCOPE',
      'Unknown ceremony rate-limit scope',
    );
  }
  return scope;
}

/**
 * Persistent ceremony rate-limit buckets. Subjects must already be hashed;
 * normalization/hashing belongs to future ceremony adapters, not this store.
 */
export async function getOrCreateCeremonyRateLimitBucket(
  db: Db,
  input: {
    id: string;
    scope: CeremonyRateLimitScope;
    subjectHash: Buffer;
    windowStartedAt: string;
    windowExpiresAt: string;
    createdAt: string;
  },
): Promise<CeremonyRateLimitRow> {
  const scope = assertApprovedScope(input.scope);
  const subjectHash = assertHashedBytes(input.subjectHash, 'rate-limit subjectHash');
  if (new Date(input.windowExpiresAt).getTime() <= new Date(input.windowStartedAt).getTime()) {
    throw new CeremonyInvariantError(
      'INVALID_RATE_LIMIT_WINDOW',
      'Rate-limit window expiry must be after window start',
    );
  }

  const existing = await db
    .select()
    .from(ceremonyRateLimits)
    .where(
      and(
        eq(ceremonyRateLimits.scope, scope),
        eq(ceremonyRateLimits.subjectHash, subjectHash),
        eq(ceremonyRateLimits.windowStartedAt, input.windowStartedAt),
      ),
    )
    .limit(1);
  if (existing[0]) {
    return existing[0];
  }

  try {
    const rows = await db
      .insert(ceremonyRateLimits)
      .values({
        id: input.id,
        scope,
        subjectHash,
        windowStartedAt: input.windowStartedAt,
        windowExpiresAt: input.windowExpiresAt,
        attemptCount: 0,
        blockedUntil: null,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      })
      .returning();
    const row = rows[0];
    if (!row) {
      throw new Error('Failed to create ceremony rate-limit bucket');
    }
    return row;
  } catch (error) {
    const raced = await db
      .select()
      .from(ceremonyRateLimits)
      .where(
        and(
          eq(ceremonyRateLimits.scope, scope),
          eq(ceremonyRateLimits.subjectHash, subjectHash),
          eq(ceremonyRateLimits.windowStartedAt, input.windowStartedAt),
        ),
      )
      .limit(1);
    if (raced[0]) {
      return raced[0];
    }
    throw error;
  }
}

export async function incrementCeremonyRateLimit(
  db: Db,
  input: { id: string; now: string },
): Promise<CeremonyRateLimitRow> {
  const updated = await db
    .update(ceremonyRateLimits)
    .set({
      attemptCount: sql`${ceremonyRateLimits.attemptCount} + 1`,
      updatedAt: input.now,
    })
    .where(eq(ceremonyRateLimits.id, input.id))
    .returning();
  const row = updated[0];
  if (!row) {
    throw new CeremonyInvariantError(
      'RATE_LIMIT_BUCKET_NOT_FOUND',
      'Ceremony rate-limit bucket was not found',
    );
  }
  return row;
}

export async function getCeremonyRateLimitCount(db: Db, id: string): Promise<number> {
  const rows = await db
    .select()
    .from(ceremonyRateLimits)
    .where(eq(ceremonyRateLimits.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new CeremonyInvariantError(
      'RATE_LIMIT_BUCKET_NOT_FOUND',
      'Ceremony rate-limit bucket was not found',
    );
  }
  return row.attemptCount;
}

export async function setCeremonyRateLimitBlockedUntil(
  db: Db,
  input: { id: string; blockedUntil: string | null; now: string },
): Promise<CeremonyRateLimitRow> {
  const updated = await db
    .update(ceremonyRateLimits)
    .set({
      blockedUntil: input.blockedUntil,
      updatedAt: input.now,
    })
    .where(eq(ceremonyRateLimits.id, input.id))
    .returning();
  const row = updated[0];
  if (!row) {
    throw new CeremonyInvariantError(
      'RATE_LIMIT_BUCKET_NOT_FOUND',
      'Ceremony rate-limit bucket was not found',
    );
  }
  return row;
}

export async function isCeremonyRateLimitBlocked(
  db: Db,
  input: { id: string; now: string },
): Promise<boolean> {
  const rows = await db
    .select()
    .from(ceremonyRateLimits)
    .where(eq(ceremonyRateLimits.id, input.id))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new CeremonyInvariantError(
      'RATE_LIMIT_BUCKET_NOT_FOUND',
      'Ceremony rate-limit bucket was not found',
    );
  }
  if (row.blockedUntil === null) {
    return false;
  }
  return new Date(input.now).getTime() < new Date(row.blockedUntil).getTime();
}

export async function findActiveCeremonyRateLimitWindow(
  db: Db,
  input: {
    scope: CeremonyRateLimitScope;
    subjectHash: Buffer;
    now: string;
  },
): Promise<CeremonyRateLimitRow | null> {
  const scope = assertApprovedScope(input.scope);
  const subjectHash = assertHashedBytes(input.subjectHash, 'rate-limit subjectHash');
  const rows = await db
    .select()
    .from(ceremonyRateLimits)
    .where(
      and(
        eq(ceremonyRateLimits.scope, scope),
        eq(ceremonyRateLimits.subjectHash, subjectHash),
        gt(ceremonyRateLimits.windowExpiresAt, input.now),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Internal/test-only helper to reset a bucket without waiting for window expiry. */
export async function resetCeremonyRateLimitForTests(
  db: Db,
  input: { id: string; now: string },
): Promise<CeremonyRateLimitRow> {
  const updated = await db
    .update(ceremonyRateLimits)
    .set({
      attemptCount: 0,
      blockedUntil: null,
      updatedAt: input.now,
    })
    .where(eq(ceremonyRateLimits.id, input.id))
    .returning();
  const row = updated[0];
  if (!row) {
    throw new CeremonyInvariantError(
      'RATE_LIMIT_BUCKET_NOT_FOUND',
      'Ceremony rate-limit bucket was not found',
    );
  }
  return row;
}

export function isApprovedCeremonyRateLimitScope(scope: string): scope is CeremonyRateLimitScope {
  return APPROVED_SCOPES.has(scope as CeremonyRateLimitScope);
}

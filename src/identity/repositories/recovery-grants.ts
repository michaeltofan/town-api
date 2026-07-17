import { and, eq, gt, isNull, ne } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { recoveryGrants, type RecoveryGrantRow } from '../../db/schema.js';
import { IdentityInvariantError } from '../errors.js';
import { assertHashedBytes } from '../hashing.js';

type Db = Database['db'];

/**
 * Restricted recovery authorization record.
 * This is not a session and must never be treated as one.
 */
export async function createRecoveryGrant(
  db: Db,
  input: {
    id: string;
    accountId: string;
    tokenHash: Buffer;
    expiresAt: string;
    createdAt: string;
  },
): Promise<RecoveryGrantRow> {
  const tokenHash = assertHashedBytes(input.tokenHash, 'recovery grant tokenHash');
  if (new Date(input.expiresAt).getTime() <= new Date(input.createdAt).getTime()) {
    throw new IdentityInvariantError(
      'INVALID_GRANT_WINDOW',
      'Recovery grant expiry must be after creation',
    );
  }

  const rows = await db
    .insert(recoveryGrants)
    .values({
      id: input.id,
      accountId: input.accountId,
      tokenHash,
      expiresAt: input.expiresAt,
      consumedAt: null,
      revokedAt: null,
      createdAt: input.createdAt,
    })
    .returning();
  const row = rows[0];
  if (!row) {
    throw new Error('Failed to create recovery grant');
  }
  return row;
}

export async function findRecoveryGrantByTokenHash(
  db: Db,
  tokenHash: Buffer,
): Promise<RecoveryGrantRow | null> {
  const hash = assertHashedBytes(tokenHash, 'recovery grant tokenHash');
  const rows = await db
    .select()
    .from(recoveryGrants)
    .where(eq(recoveryGrants.tokenHash, hash))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Consume a recovery grant. Does not emit security events — the recovery service owns those.
 * `eventId` is retained for API compatibility with prior callers but is unused.
 */
export async function consumeRecoveryGrant(
  db: Db,
  input: {
    grantId: string;
    now: string;
    eventId?: string;
    requestId?: string | null;
  },
): Promise<RecoveryGrantRow> {
  const existing = await db
    .select()
    .from(recoveryGrants)
    .where(eq(recoveryGrants.id, input.grantId))
    .limit(1);
  const grant = existing[0];
  if (!grant) {
    throw new IdentityInvariantError('GRANT_NOT_FOUND', 'Recovery grant was not found');
  }
  if (grant.consumedAt !== null) {
    throw new IdentityInvariantError('GRANT_ALREADY_CONSUMED', 'Recovery grant already consumed');
  }
  if (grant.revokedAt !== null) {
    throw new IdentityInvariantError('GRANT_REVOKED', 'Recovery grant has been revoked');
  }
  if (new Date(input.now).getTime() >= new Date(grant.expiresAt).getTime()) {
    throw new IdentityInvariantError('GRANT_EXPIRED', 'Recovery grant has expired');
  }

  const updated = await db
    .update(recoveryGrants)
    .set({ consumedAt: input.now })
    .where(
      and(
        eq(recoveryGrants.id, input.grantId),
        isNull(recoveryGrants.consumedAt),
        isNull(recoveryGrants.revokedAt),
        gt(recoveryGrants.expiresAt, input.now),
      ),
    )
    .returning();
  const row = updated[0];
  if (!row) {
    throw new IdentityInvariantError('GRANT_ALREADY_CONSUMED', 'Recovery grant already consumed');
  }

  return row;
}

export async function revokeRecoveryGrant(
  db: Db,
  input: { grantId: string; now: string },
): Promise<RecoveryGrantRow | null> {
  const updated = await db
    .update(recoveryGrants)
    .set({ revokedAt: input.now })
    .where(
      and(
        eq(recoveryGrants.id, input.grantId),
        isNull(recoveryGrants.consumedAt),
        isNull(recoveryGrants.revokedAt),
      ),
    )
    .returning();
  return updated[0] ?? null;
}

export async function revokeActiveRecoveryGrantsForAccount(
  db: Db,
  input: {
    accountId: string;
    now: string;
    excludeGrantId?: string;
  },
): Promise<number> {
  const conditions = [
    eq(recoveryGrants.accountId, input.accountId),
    isNull(recoveryGrants.consumedAt),
    isNull(recoveryGrants.revokedAt),
    gt(recoveryGrants.expiresAt, input.now),
  ];
  if (input.excludeGrantId !== undefined) {
    conditions.push(ne(recoveryGrants.id, input.excludeGrantId));
  }

  const updated = await db
    .update(recoveryGrants)
    .set({ revokedAt: input.now })
    .where(and(...conditions))
    .returning({ id: recoveryGrants.id });
  return updated.length;
}

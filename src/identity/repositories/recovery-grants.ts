import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { recoveryGrants, type RecoveryGrantRow } from '../../db/schema.js';
import { IdentityInvariantError } from '../errors.js';
import { assertHashedBytes } from '../hashing.js';
import { appendIdentitySecurityEvent } from './security-events.js';

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
      createdAt: input.createdAt,
    })
    .returning();
  const row = rows[0];
  if (!row) {
    throw new Error('Failed to create recovery grant');
  }
  return row;
}

export async function consumeRecoveryGrant(
  db: Db,
  input: {
    grantId: string;
    now: string;
    eventId: string;
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
  if (new Date(input.now).getTime() >= new Date(grant.expiresAt).getTime()) {
    throw new IdentityInvariantError('GRANT_EXPIRED', 'Recovery grant has expired');
  }

  const updated = await db
    .update(recoveryGrants)
    .set({ consumedAt: input.now })
    .where(eq(recoveryGrants.id, input.grantId))
    .returning();
  const row = updated[0];
  if (!row) {
    throw new Error('Failed to consume recovery grant');
  }

  await appendIdentitySecurityEvent(db, {
    id: input.eventId,
    accountId: grant.accountId,
    eventType: 'recovery_completed',
    occurredAt: input.now,
    requestId: input.requestId ?? null,
    metadata: { grantId: grant.id },
  });

  return row;
}

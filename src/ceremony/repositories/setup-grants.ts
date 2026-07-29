import { and, eq, gt, isNull, ne } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  accounts,
  setupGrants,
  type AccountStatus,
  type SetupGrantPurpose,
  type SetupGrantRow,
} from '../../db/schema.js';
import { assertHashedBytes } from '../../identity/hashing.js';
import { CeremonyInvariantError } from '../errors.js';

type Db = Database['db'];

const APPROVED_PURPOSES = new Set<SetupGrantPurpose>([
  'initial_password_setup',
  'initial_passkey_registration',
]);

const REQUIRED_STATUS_BY_PURPOSE: Record<SetupGrantPurpose, AccountStatus> = {
  initial_password_setup: 'pending_password',
  initial_passkey_registration: 'pending_passkey',
};

function assertApprovedPurpose(purpose: SetupGrantPurpose): SetupGrantPurpose {
  if (!APPROVED_PURPOSES.has(purpose)) {
    throw new CeremonyInvariantError('INVALID_SETUP_GRANT_PURPOSE', 'Invalid setup grant purpose');
  }
  return purpose;
}

function requiredStatusForPurpose(purpose: SetupGrantPurpose): AccountStatus {
  return REQUIRED_STATUS_BY_PURPOSE[assertApprovedPurpose(purpose)];
}

function statusMismatchError(purpose: SetupGrantPurpose): CeremonyInvariantError {
  if (purpose === 'initial_password_setup') {
    return new CeremonyInvariantError(
      'SETUP_GRANT_REQUIRES_PENDING_PASSWORD',
      'Password setup grants may only be issued for pending_password accounts',
    );
  }
  return new CeremonyInvariantError(
    'SETUP_GRANT_REQUIRES_PENDING_PASSKEY',
    'Passkey setup grants may only be issued for pending_passkey accounts',
  );
}

/**
 * Revoke previous unconsumed, unrevoked, unexpired setup grants for an account/purpose.
 */
export async function revokeActiveSetupGrantsForAccount(
  db: Db,
  input: {
    accountId: string;
    purpose: SetupGrantPurpose;
    now: string;
    excludeGrantId?: string;
  },
): Promise<number> {
  assertApprovedPurpose(input.purpose);
  const conditions = [
    eq(setupGrants.accountId, input.accountId),
    eq(setupGrants.purpose, input.purpose),
    isNull(setupGrants.consumedAt),
    isNull(setupGrants.revokedAt),
    gt(setupGrants.expiresAt, input.now),
  ];
  if (input.excludeGrantId !== undefined) {
    conditions.push(ne(setupGrants.id, input.excludeGrantId));
  }
  const updated = await db
    .update(setupGrants)
    .set({ revokedAt: input.now })
    .where(and(...conditions))
    .returning({ id: setupGrants.id });
  return updated.length;
}

/**
 * Setup grants are restricted pre-authentication authority, not sessions.
 * They cannot authorize normal APIs, civic actions, membership, or session creation alone.
 * Each purpose authorizes exactly one setup step and requires a matching account status.
 */
export async function createSetupGrant(
  db: Db,
  input: {
    id: string;
    accountId: string;
    tokenHash: Buffer;
    purpose: SetupGrantPurpose;
    expiresAt: string;
    createdAt: string;
  },
): Promise<SetupGrantRow> {
  const tokenHash = assertHashedBytes(input.tokenHash, 'setup grant tokenHash');
  const purpose = assertApprovedPurpose(input.purpose);
  if (new Date(input.expiresAt).getTime() <= new Date(input.createdAt).getTime()) {
    throw new CeremonyInvariantError(
      'INVALID_GRANT_WINDOW',
      'Setup grant expiry must be after creation',
    );
  }

  const accountRows = await db
    .select()
    .from(accounts)
    .where(eq(accounts.id, input.accountId))
    .limit(1);
  const account = accountRows[0];
  if (!account) {
    throw new CeremonyInvariantError('ACCOUNT_NOT_FOUND', 'Account was not found');
  }
  const requiredStatus = requiredStatusForPurpose(purpose);
  if (account.status !== requiredStatus) {
    throw statusMismatchError(purpose);
  }

  const rows = await db
    .insert(setupGrants)
    .values({
      id: input.id,
      accountId: input.accountId,
      tokenHash,
      purpose,
      expiresAt: input.expiresAt,
      consumedAt: null,
      revokedAt: null,
      createdAt: input.createdAt,
    })
    .returning();
  const row = rows[0];
  if (!row) {
    throw new Error('Failed to create setup grant');
  }
  return row;
}

export async function findActiveSetupGrantByTokenHash(
  db: Db,
  input: {
    tokenHash: Buffer;
    purpose: SetupGrantPurpose;
    accountId?: string;
    now: string;
  },
): Promise<SetupGrantRow> {
  const tokenHash = assertHashedBytes(input.tokenHash, 'setup grant tokenHash');
  const purpose = assertApprovedPurpose(input.purpose);

  const rows = await db
    .select()
    .from(setupGrants)
    .where(eq(setupGrants.tokenHash, tokenHash))
    .limit(1);
  const grant = rows[0];
  if (!grant) {
    throw new CeremonyInvariantError('SETUP_GRANT_NOT_FOUND', 'Setup grant was not found');
  }
  if (grant.purpose !== purpose) {
    throw new CeremonyInvariantError('SETUP_GRANT_WRONG_PURPOSE', 'Setup grant purpose mismatch');
  }
  if (input.accountId !== undefined && grant.accountId !== input.accountId) {
    throw new CeremonyInvariantError(
      'SETUP_GRANT_WRONG_ACCOUNT',
      'Setup grant belongs to another account',
    );
  }
  if (grant.consumedAt !== null) {
    throw new CeremonyInvariantError('SETUP_GRANT_CONSUMED', 'Setup grant already consumed');
  }
  if (grant.revokedAt !== null) {
    throw new CeremonyInvariantError('SETUP_GRANT_REVOKED', 'Setup grant has been revoked');
  }
  if (new Date(input.now).getTime() >= new Date(grant.expiresAt).getTime()) {
    throw new CeremonyInvariantError('SETUP_GRANT_EXPIRED', 'Setup grant has expired');
  }

  const accountRows = await db
    .select()
    .from(accounts)
    .where(eq(accounts.id, grant.accountId))
    .limit(1);
  const account = accountRows[0];
  if (!account) {
    throw new CeremonyInvariantError('ACCOUNT_NOT_FOUND', 'Account was not found');
  }
  if (account.status !== requiredStatusForPurpose(purpose)) {
    throw statusMismatchError(purpose);
  }

  return grant;
}

export async function consumeSetupGrant(
  db: Db,
  input: {
    grantId: string;
    accountId: string;
    purpose: SetupGrantPurpose;
    now: string;
  },
): Promise<SetupGrantRow> {
  assertApprovedPurpose(input.purpose);

  const updated = await db
    .update(setupGrants)
    .set({ consumedAt: input.now })
    .where(
      and(
        eq(setupGrants.id, input.grantId),
        eq(setupGrants.accountId, input.accountId),
        eq(setupGrants.purpose, input.purpose),
        isNull(setupGrants.consumedAt),
        isNull(setupGrants.revokedAt),
        gt(setupGrants.expiresAt, input.now),
      ),
    )
    .returning();

  const row = updated[0];
  if (!row) {
    const existing = await db
      .select()
      .from(setupGrants)
      .where(eq(setupGrants.id, input.grantId))
      .limit(1);
    const grant = existing[0];
    if (!grant) {
      throw new CeremonyInvariantError('SETUP_GRANT_NOT_FOUND', 'Setup grant was not found');
    }
    if (grant.accountId !== input.accountId) {
      throw new CeremonyInvariantError(
        'SETUP_GRANT_WRONG_ACCOUNT',
        'Setup grant belongs to another account',
      );
    }
    if (grant.purpose !== input.purpose) {
      throw new CeremonyInvariantError('SETUP_GRANT_WRONG_PURPOSE', 'Setup grant purpose mismatch');
    }
    if (grant.consumedAt !== null) {
      throw new CeremonyInvariantError('SETUP_GRANT_CONSUMED', 'Setup grant already consumed');
    }
    if (grant.revokedAt !== null) {
      throw new CeremonyInvariantError('SETUP_GRANT_REVOKED', 'Setup grant has been revoked');
    }
    if (new Date(input.now).getTime() >= new Date(grant.expiresAt).getTime()) {
      throw new CeremonyInvariantError('SETUP_GRANT_EXPIRED', 'Setup grant has expired');
    }
    throw new CeremonyInvariantError('SETUP_GRANT_CONSUME_FAILED', 'Failed to consume setup grant');
  }

  return row;
}

export async function revokeSetupGrant(
  db: Db,
  input: { grantId: string; now: string },
): Promise<SetupGrantRow> {
  const updated = await db
    .update(setupGrants)
    .set({ revokedAt: input.now })
    .where(
      and(
        eq(setupGrants.id, input.grantId),
        isNull(setupGrants.revokedAt),
        isNull(setupGrants.consumedAt),
      ),
    )
    .returning();

  const row = updated[0];
  if (row) {
    return row;
  }

  const existing = await db
    .select()
    .from(setupGrants)
    .where(eq(setupGrants.id, input.grantId))
    .limit(1);
  const grant = existing[0];
  if (!grant) {
    throw new CeremonyInvariantError('SETUP_GRANT_NOT_FOUND', 'Setup grant was not found');
  }
  if (grant.revokedAt !== null) {
    return grant;
  }
  if (grant.consumedAt !== null) {
    throw new CeremonyInvariantError(
      'SETUP_GRANT_CONSUMED',
      'Consumed setup grants cannot be revoked',
    );
  }
  throw new CeremonyInvariantError('SETUP_GRANT_REVOKE_FAILED', 'Failed to revoke setup grant');
}

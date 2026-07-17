import { and, count, eq, isNull } from 'drizzle-orm';
import { randomUUID as cryptoRandomUuid } from 'node:crypto';
import type { Database } from '../../db/client.js';
import {
  accounts,
  passkeyCredentials,
  type PasskeyCredentialRow,
  type PasskeyRevocationReason,
} from '../../db/schema.js';
import { IdentityInvariantError } from '../errors.js';

type Db = Database['db'];

export async function addPasskeyCredential(
  db: Db,
  input: {
    id: string;
    publicId?: string;
    accountId: string;
    credentialId: Buffer;
    publicKey: Buffer;
    signCount: number;
    transports?: string[] | null;
    deviceType?: 'platform' | 'cross_platform' | null;
    backedUp?: boolean | null;
    backupEligible?: boolean | null;
    aaguid?: string | null;
    label?: string | null;
    createdAt: string;
  },
): Promise<PasskeyCredentialRow> {
  if (input.signCount < 0) {
    throw new IdentityInvariantError('INVALID_SIGN_COUNT', 'Passkey sign count cannot be negative');
  }

  try {
    const rows = await db
      .insert(passkeyCredentials)
      .values({
        id: input.id,
        publicId: input.publicId ?? cryptoRandomUuid(),
        accountId: input.accountId,
        credentialId: input.credentialId,
        publicKey: input.publicKey,
        signCount: input.signCount,
        transports: input.transports ?? null,
        deviceType: input.deviceType ?? null,
        backedUp: input.backedUp ?? null,
        backupEligible: input.backupEligible ?? null,
        aaguid: input.aaguid ?? null,
        label: input.label ?? null,
        lastUsedAt: null,
        createdAt: input.createdAt,
        revokedAt: null,
        revocationReason: null,
      })
      .returning();
    const row = rows[0];
    if (!row) {
      throw new Error('Failed to add passkey credential');
    }
    return row;
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const causeMessage =
      error instanceof Error && error.cause instanceof Error ? error.cause.message : '';
    if (
      /passkey_credentials_credential_id_unique/i.test(message) ||
      /passkey_credentials_credential_id_unique/i.test(causeMessage)
    ) {
      throw new IdentityInvariantError(
        'DUPLICATE_CREDENTIAL_ID',
        'Passkey credential id already exists',
      );
    }
    throw error;
  }
}

export async function listActivePasskeys(
  db: Db,
  accountId: string,
): Promise<PasskeyCredentialRow[]> {
  return db
    .select()
    .from(passkeyCredentials)
    .where(and(eq(passkeyCredentials.accountId, accountId), isNull(passkeyCredentials.revokedAt)));
}

export async function findActivePasskeyByCredentialId(
  db: Db,
  credentialId: Buffer,
): Promise<PasskeyCredentialRow | null> {
  const rows = await db
    .select()
    .from(passkeyCredentials)
    .where(
      and(eq(passkeyCredentials.credentialId, credentialId), isNull(passkeyCredentials.revokedAt)),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function updatePasskeyAuthenticationState(
  db: Db,
  input: {
    credentialRowId: string;
    signCount: number;
    backedUp: boolean | null;
    backupEligible: boolean | null;
    lastUsedAt: string;
  },
): Promise<PasskeyCredentialRow> {
  if (input.signCount < 0) {
    throw new IdentityInvariantError('INVALID_SIGN_COUNT', 'Passkey sign count cannot be negative');
  }

  const existing = await db
    .select()
    .from(passkeyCredentials)
    .where(eq(passkeyCredentials.id, input.credentialRowId))
    .limit(1)
    .for('update');
  const credential = existing[0];
  if (!credential || credential.revokedAt != null) {
    throw new IdentityInvariantError('PASSKEY_NOT_ACTIVE', 'Passkey is not active');
  }

  const updated = await db
    .update(passkeyCredentials)
    .set({
      signCount: input.signCount,
      backedUp: input.backedUp,
      backupEligible: input.backupEligible,
      lastUsedAt: input.lastUsedAt,
    })
    .where(eq(passkeyCredentials.id, input.credentialRowId))
    .returning();
  const row = updated[0];
  if (!row) {
    throw new Error('Failed to update passkey authentication state');
  }
  return row;
}

export async function findActivePasskeyByPublicId(
  db: Db,
  input: { publicId: string; accountId: string },
): Promise<PasskeyCredentialRow | null> {
  const rows = await db
    .select()
    .from(passkeyCredentials)
    .where(
      and(
        eq(passkeyCredentials.publicId, input.publicId),
        eq(passkeyCredentials.accountId, input.accountId),
        isNull(passkeyCredentials.revokedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function updatePasskeyLabel(
  db: Db,
  input: { credentialRowId: string; label: string | null },
): Promise<PasskeyCredentialRow> {
  const updated = await db
    .update(passkeyCredentials)
    .set({ label: input.label })
    .where(
      and(eq(passkeyCredentials.id, input.credentialRowId), isNull(passkeyCredentials.revokedAt)),
    )
    .returning();
  const row = updated[0];
  if (!row) {
    throw new IdentityInvariantError('PASSKEY_NOT_ACTIVE', 'Passkey is not active');
  }
  return row;
}

export async function revokePasskey(
  db: Db,
  input: {
    credentialRowId: string;
    revokedAt: string;
    revocationReason?: PasskeyRevocationReason;
  },
): Promise<PasskeyCredentialRow> {
  const existing = await db
    .select()
    .from(passkeyCredentials)
    .where(eq(passkeyCredentials.id, input.credentialRowId))
    .limit(1)
    .for('update');
  const credential = existing[0];
  if (credential?.revokedAt != null) {
    throw new IdentityInvariantError('PASSKEY_NOT_ACTIVE', 'Passkey is not active');
  }
  if (!credential) {
    throw new IdentityInvariantError('PASSKEY_NOT_ACTIVE', 'Passkey is not active');
  }

  const account = await db
    .select()
    .from(accounts)
    .where(eq(accounts.id, credential.accountId))
    .limit(1);
  const accountRow = account[0];
  if (!accountRow) {
    throw new IdentityInvariantError('ACCOUNT_NOT_FOUND', 'Account was not found');
  }

  if (accountRow.status === 'active') {
    const activeCount = await db
      .select({ value: count() })
      .from(passkeyCredentials)
      .where(
        and(
          eq(passkeyCredentials.accountId, credential.accountId),
          isNull(passkeyCredentials.revokedAt),
        ),
      );
    if ((activeCount[0]?.value ?? 0) <= 1) {
      throw new IdentityInvariantError(
        'FINAL_PASSKEY_PROTECTED',
        'Cannot revoke the final active passkey for an active account',
      );
    }
  }

  const updated = await db
    .update(passkeyCredentials)
    .set({
      revokedAt: input.revokedAt,
      revocationReason: input.revocationReason ?? 'user_requested',
    })
    .where(
      and(eq(passkeyCredentials.id, input.credentialRowId), isNull(passkeyCredentials.revokedAt)),
    )
    .returning();
  const row = updated[0];
  if (!row) {
    throw new Error('Failed to revoke passkey');
  }
  return row;
}

/**
 * Updates sign count only when the new value is greater than or equal to the stored value.
 * Decreasing counters are rejected (cloned authenticator / replay protection policy).
 */
export async function updateSignCount(
  db: Db,
  input: { credentialRowId: string; signCount: number; lastUsedAt: string },
): Promise<PasskeyCredentialRow> {
  if (input.signCount < 0) {
    throw new IdentityInvariantError('INVALID_SIGN_COUNT', 'Passkey sign count cannot be negative');
  }

  const existing = await db
    .select()
    .from(passkeyCredentials)
    .where(eq(passkeyCredentials.id, input.credentialRowId))
    .limit(1);
  const credential = existing[0];
  if (credential?.revokedAt != null) {
    throw new IdentityInvariantError('PASSKEY_NOT_ACTIVE', 'Passkey is not active');
  }
  if (!credential) {
    throw new IdentityInvariantError('PASSKEY_NOT_ACTIVE', 'Passkey is not active');
  }

  if (input.signCount < credential.signCount) {
    throw new IdentityInvariantError(
      'SIGN_COUNT_DECREASE_REJECTED',
      'Passkey sign count cannot decrease',
    );
  }

  const updated = await db
    .update(passkeyCredentials)
    .set({ signCount: input.signCount, lastUsedAt: input.lastUsedAt })
    .where(eq(passkeyCredentials.id, input.credentialRowId))
    .returning();
  const row = updated[0];
  if (!row) {
    throw new Error('Failed to update passkey sign count');
  }
  return row;
}

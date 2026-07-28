import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  accountPasswordCredentials,
  type AccountPasswordCredentialRow,
  type PasswordKdfParametersRecord,
} from '../../db/schema.js';
import { IdentityInvariantError } from '../errors.js';
import { PASSWORD_KDF_ALGORITHM, type PasswordKdfAlgorithm } from '../password-policy.js';

type Db = Database['db'];

function isUniqueActiveViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  const causeMessage =
    error instanceof Error && error.cause instanceof Error ? error.cause.message : '';
  return (
    /account_password_credentials_one_active_per_account/i.test(message) ||
    /account_password_credentials_one_active_per_account/i.test(causeMessage)
  );
}

/**
 * Persist a new active password credential for an account.
 * At most one active (revoked_at IS NULL) credential is allowed per account.
 * Callers must supply a KDF output string — never plaintext.
 */
export async function createAccountPasswordCredential(
  db: Db,
  input: {
    id: string;
    accountId: string;
    passwordHash: string;
    algorithm?: PasswordKdfAlgorithm;
    parameters: PasswordKdfParametersRecord;
    createdAt: string;
  },
): Promise<AccountPasswordCredentialRow> {
  if (typeof input.passwordHash !== 'string' || input.passwordHash.length === 0) {
    throw new IdentityInvariantError(
      'INVALID_PASSWORD_HASH',
      'Password hash must be a non-empty string',
    );
  }

  const algorithm = input.algorithm ?? PASSWORD_KDF_ALGORITHM;

  try {
    const rows = await db
      .insert(accountPasswordCredentials)
      .values({
        id: input.id,
        accountId: input.accountId,
        passwordHash: input.passwordHash,
        algorithm,
        parameters: input.parameters,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
        revokedAt: null,
      })
      .returning();
    const row = rows[0];
    if (!row) {
      throw new Error('Failed to create account password credential');
    }
    return row;
  } catch (error) {
    if (isUniqueActiveViolation(error)) {
      throw new IdentityInvariantError(
        'DUPLICATE_ACTIVE_PASSWORD_CREDENTIAL',
        'Account already has an active password credential',
      );
    }
    throw error;
  }
}

export async function findActiveAccountPasswordCredential(
  db: Db,
  accountId: string,
): Promise<AccountPasswordCredentialRow | null> {
  const rows = await db
    .select()
    .from(accountPasswordCredentials)
    .where(
      and(
        eq(accountPasswordCredentials.accountId, accountId),
        isNull(accountPasswordCredentials.revokedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function findAccountPasswordCredentialById(
  db: Db,
  credentialId: string,
): Promise<AccountPasswordCredentialRow | null> {
  const rows = await db
    .select()
    .from(accountPasswordCredentials)
    .where(eq(accountPasswordCredentials.id, credentialId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Soft-revoke the active password credential for an account.
 * Sets revoked_at and bumps updated_at. Idempotent miss → invariant error.
 */
export async function revokeAccountPasswordCredential(
  db: Db,
  input: {
    accountId: string;
    revokedAt: string;
  },
): Promise<AccountPasswordCredentialRow> {
  const existing = await db
    .select()
    .from(accountPasswordCredentials)
    .where(
      and(
        eq(accountPasswordCredentials.accountId, input.accountId),
        isNull(accountPasswordCredentials.revokedAt),
      ),
    )
    .limit(1)
    .for('update');
  const credential = existing[0];
  if (!credential) {
    throw new IdentityInvariantError(
      'PASSWORD_CREDENTIAL_NOT_ACTIVE',
      'No active password credential for account',
    );
  }

  const updated = await db
    .update(accountPasswordCredentials)
    .set({
      revokedAt: input.revokedAt,
      updatedAt: input.revokedAt,
    })
    .where(
      and(
        eq(accountPasswordCredentials.id, credential.id),
        isNull(accountPasswordCredentials.revokedAt),
      ),
    )
    .returning();
  const row = updated[0];
  if (!row) {
    throw new Error('Failed to revoke account password credential');
  }
  return row;
}

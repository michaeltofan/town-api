import { and, count, eq, isNull } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  accountEmails,
  accountPasswordCredentials,
  accounts,
  actors,
  passkeyCredentials,
  type AccountRow,
  type AccountStatus,
} from '../../db/schema.js';
import { IdentityInvariantError } from '../errors.js';

type Db = Database['db'];

const WEBAUTHN_USER_HANDLE_BYTES = 32;

const VALID_TRANSITIONS: Record<AccountStatus, readonly AccountStatus[]> = {
  pending_email: ['pending_password'],
  pending_password: ['pending_passkey'],
  pending_passkey: ['active'],
  active: ['suspended', 'closed'],
  suspended: ['active', 'closed'],
  closed: [],
};

export async function createAccountShell(
  db: Db,
  input: { id: string; createdAt: string; updatedAt: string },
): Promise<AccountRow> {
  const rows = await db
    .insert(accounts)
    .values({
      id: input.id,
      status: 'pending_email',
      webauthnUserHandle: null,
      accountReadyAt: null,
      recoveryCompletedAt: null,
      suspendedAt: null,
      closedAt: null,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    })
    .returning();

  const row = rows[0];
  if (!row) {
    throw new Error('Failed to create account shell');
  }
  return row;
}

export async function findAccountById(db: Db, accountId: string): Promise<AccountRow | null> {
  const rows = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
  return rows[0] ?? null;
}

/**
 * Ensure a pending_passkey (or later) account has a stable opaque 32-byte WebAuthn user handle.
 * Concurrent callers race on unique index and converge on exactly one handle.
 */
export async function ensureWebAuthnUserHandle(
  db: Db,
  input: {
    accountId: string;
    handle: Buffer;
    now: string;
  },
): Promise<Buffer> {
  if (!Buffer.isBuffer(input.handle) || input.handle.length !== WEBAUTHN_USER_HANDLE_BYTES) {
    throw new IdentityInvariantError(
      'INVALID_WEBAUTHN_USER_HANDLE',
      'WebAuthn user handle must be exactly 32 bytes',
    );
  }

  const existing = await findAccountById(db, input.accountId);
  if (!existing) {
    throw new IdentityInvariantError('ACCOUNT_NOT_FOUND', 'Account was not found');
  }
  if (existing.webauthnUserHandle) {
    return Buffer.isBuffer(existing.webauthnUserHandle)
      ? existing.webauthnUserHandle
      : Buffer.from(existing.webauthnUserHandle);
  }

  try {
    const updated = await db
      .update(accounts)
      .set({ webauthnUserHandle: input.handle, updatedAt: input.now })
      .where(and(eq(accounts.id, input.accountId), isNull(accounts.webauthnUserHandle)))
      .returning({ webauthnUserHandle: accounts.webauthnUserHandle });
    const row = updated[0];
    if (row?.webauthnUserHandle) {
      return Buffer.isBuffer(row.webauthnUserHandle)
        ? row.webauthnUserHandle
        : Buffer.from(row.webauthnUserHandle);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const causeMessage =
      error instanceof Error && error.cause instanceof Error ? error.cause.message : '';
    if (
      !/accounts_webauthn_user_handle_unique/i.test(message) &&
      !/accounts_webauthn_user_handle_unique/i.test(causeMessage)
    ) {
      throw error;
    }
  }

  const raced = await findAccountById(db, input.accountId);
  if (!raced?.webauthnUserHandle) {
    throw new Error('Failed to create or locate WebAuthn user handle');
  }
  return Buffer.isBuffer(raced.webauthnUserHandle)
    ? raced.webauthnUserHandle
    : Buffer.from(raced.webauthnUserHandle);
}

/** Lock account row for concurrent ceremony completion. */
export async function lockAccountById(db: Db, accountId: string): Promise<AccountRow | null> {
  const selected = await db
    .select()
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1)
    .for('update');
  return selected[0] ?? null;
}

async function assertActiveRequirements(db: Db, accountId: string): Promise<void> {
  const account = await findAccountById(db, accountId);
  if (!account?.webauthnUserHandle) {
    throw new IdentityInvariantError(
      'ACTIVE_REQUIRES_WEBAUTHN_USER_HANDLE',
      'Active account requires a WebAuthn user handle',
    );
  }

  const primary = await db
    .select()
    .from(accountEmails)
    .where(
      and(
        eq(accountEmails.accountId, accountId),
        eq(accountEmails.isPrimary, true),
        isNull(accountEmails.revokedAt),
      ),
    )
    .limit(1);

  if (primary[0]?.verifiedAt == null) {
    throw new IdentityInvariantError(
      'ACTIVE_REQUIRES_VERIFIED_PRIMARY_EMAIL',
      'Active account requires a verified primary email',
    );
  }

  const passkeys = await db
    .select({ value: count() })
    .from(passkeyCredentials)
    .where(and(eq(passkeyCredentials.accountId, accountId), isNull(passkeyCredentials.revokedAt)));
  if ((passkeys[0]?.value ?? 0) < 1) {
    throw new IdentityInvariantError(
      'ACTIVE_REQUIRES_ACTIVE_PASSKEY',
      'Active account requires at least one active passkey',
    );
  }

  const passwords = await db
    .select({ value: count() })
    .from(accountPasswordCredentials)
    .where(
      and(
        eq(accountPasswordCredentials.accountId, accountId),
        isNull(accountPasswordCredentials.revokedAt),
      ),
    );
  if ((passwords[0]?.value ?? 0) < 1) {
    throw new IdentityInvariantError(
      'ACTIVE_REQUIRES_ACTIVE_PASSWORD',
      'Active account requires an active password credential',
    );
  }

  const linked = await db.select().from(actors).where(eq(actors.accountId, accountId)).limit(1);
  if (!linked[0]) {
    throw new IdentityInvariantError(
      'ACTIVE_REQUIRES_LINKED_ACTOR',
      'Active account requires a linked civic actor',
    );
  }
}

export async function transitionAccountState(
  db: Db,
  input: {
    accountId: string;
    to: AccountStatus;
    at: string;
  },
): Promise<AccountRow> {
  const account = await findAccountById(db, input.accountId);
  if (!account) {
    throw new IdentityInvariantError('ACCOUNT_NOT_FOUND', 'Account was not found');
  }

  const from = account.status as AccountStatus;
  if (!VALID_TRANSITIONS[from].includes(input.to)) {
    throw new IdentityInvariantError(
      'INVALID_ACCOUNT_TRANSITION',
      `Invalid account transition from ${from} to ${input.to}`,
    );
  }

  if (input.to === 'active') {
    await assertActiveRequirements(db, input.accountId);
  }

  let next: Omit<AccountRow, 'id' | 'createdAt'> = {
    status: input.to,
    // Preserve inert owner label; this path never branches on or sets isOwner.
    isOwner: account.isOwner,
    webauthnUserHandle: account.webauthnUserHandle,
    accountReadyAt: account.accountReadyAt,
    recoveryCompletedAt: account.recoveryCompletedAt,
    suspendedAt: account.suspendedAt,
    closedAt: account.closedAt,
    updatedAt: input.at,
  };

  if (from === 'pending_passkey' && input.to === 'active') {
    next = {
      ...next,
      accountReadyAt: input.at,
      suspendedAt: null,
      closedAt: null,
    };
  } else if (input.to === 'suspended') {
    next = {
      ...next,
      accountReadyAt: account.accountReadyAt ?? input.at,
      suspendedAt: input.at,
      closedAt: null,
    };
  } else if (from === 'suspended' && input.to === 'active') {
    await assertActiveRequirements(db, input.accountId);
    next = {
      ...next,
      accountReadyAt: account.accountReadyAt ?? input.at,
      suspendedAt: null,
      closedAt: null,
    };
  } else if (input.to === 'closed') {
    next = {
      ...next,
      accountReadyAt: account.accountReadyAt ?? input.at,
      closedAt: input.at,
    };
  }

  const rows = await db
    .update(accounts)
    .set(next)
    .where(eq(accounts.id, input.accountId))
    .returning();

  const row = rows[0];
  if (!row) {
    throw new Error('Failed to transition account state');
  }
  return row;
}

/**
 * Sets recovery_completed_at without changing status or account_ready_at.
 * Recovery completion keeps the account active and does not re-activate.
 */
export async function setAccountRecoveryCompletedAt(
  db: Db,
  input: {
    accountId: string;
    recoveryCompletedAt: string;
    updatedAt: string;
  },
): Promise<AccountRow> {
  const updated = await db
    .update(accounts)
    .set({
      recoveryCompletedAt: input.recoveryCompletedAt,
      updatedAt: input.updatedAt,
    })
    .where(eq(accounts.id, input.accountId))
    .returning();
  const row = updated[0];
  if (!row) {
    throw new IdentityInvariantError('ACCOUNT_NOT_FOUND', 'Account was not found');
  }
  return row;
}

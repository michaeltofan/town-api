import { and, count, eq, isNull } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  accountEmails,
  accounts,
  actors,
  passkeyCredentials,
  type AccountRow,
  type AccountStatus,
} from '../../db/schema.js';
import { IdentityInvariantError } from '../errors.js';

type Db = Database['db'];

const VALID_TRANSITIONS: Record<AccountStatus, readonly AccountStatus[]> = {
  pending_email: ['pending_passkey'],
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
      accountReadyAt: null,
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

async function assertActiveRequirements(db: Db, accountId: string): Promise<void> {
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
    accountReadyAt: account.accountReadyAt,
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

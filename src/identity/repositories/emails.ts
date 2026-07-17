import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { accountEmails, type AccountEmailRow } from '../../db/schema.js';
import { normalizeEmail } from '../email-normalize.js';
import { IdentityInvariantError } from '../errors.js';

type Db = Database['db'];

export async function addAccountEmail(
  db: Db,
  input: {
    id: string;
    accountId: string;
    email: string;
    isPrimary: boolean;
    createdAt: string;
    updatedAt: string;
  },
): Promise<AccountEmailRow> {
  const emailNormalized = normalizeEmail(input.email);

  if (input.isPrimary) {
    const existingPrimary = await db
      .select()
      .from(accountEmails)
      .where(
        and(
          eq(accountEmails.accountId, input.accountId),
          eq(accountEmails.isPrimary, true),
          isNull(accountEmails.revokedAt),
        ),
      )
      .limit(1);
    if (existingPrimary[0]) {
      throw new IdentityInvariantError(
        'PRIMARY_EMAIL_EXISTS',
        'Account already has an active primary email',
      );
    }
  }

  try {
    const rows = await db
      .insert(accountEmails)
      .values({
        id: input.id,
        accountId: input.accountId,
        emailOriginal: input.email.trim(),
        emailNormalized,
        isPrimary: input.isPrimary,
        verifiedAt: null,
        revokedAt: null,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
      })
      .returning();
    const row = rows[0];
    if (!row) {
      throw new Error('Failed to add account email');
    }
    return row;
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const causeMessage =
      error instanceof Error && error.cause instanceof Error ? error.cause.message : '';
    if (
      /account_emails_active_normalized_unique/i.test(message) ||
      /account_emails_active_normalized_unique/i.test(causeMessage)
    ) {
      throw new IdentityInvariantError(
        'EMAIL_ALREADY_ACTIVE',
        'An active account already uses this email',
      );
    }
    throw error;
  }
}

export async function findActiveEmailByNormalized(
  db: Db,
  emailNormalized: string,
): Promise<AccountEmailRow | null> {
  const rows = await db
    .select()
    .from(accountEmails)
    .where(and(eq(accountEmails.emailNormalized, emailNormalized), isNull(accountEmails.revokedAt)))
    .limit(1);
  return rows[0] ?? null;
}

export async function findVerifiedPrimaryEmailForAccount(
  db: Db,
  accountId: string,
  options?: { forUpdate?: boolean },
): Promise<AccountEmailRow | null> {
  const query = db
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
  const rows = options?.forUpdate ? await query.for('update') : await query;
  const row = rows[0];
  if (row?.verifiedAt == null) {
    return null;
  }
  return row;
}

export async function verifyEmail(
  db: Db,
  input: { emailId: string; verifiedAt: string },
): Promise<AccountEmailRow> {
  const existing = await db
    .select()
    .from(accountEmails)
    .where(eq(accountEmails.id, input.emailId))
    .limit(1);
  const row = existing[0];
  if (row?.revokedAt != null) {
    throw new IdentityInvariantError('EMAIL_NOT_ACTIVE', 'Email is not active');
  }
  if (!row) {
    throw new IdentityInvariantError('EMAIL_NOT_ACTIVE', 'Email is not active');
  }

  const updated = await db
    .update(accountEmails)
    .set({ verifiedAt: input.verifiedAt, updatedAt: input.verifiedAt })
    .where(eq(accountEmails.id, input.emailId))
    .returning();
  const result = updated[0];
  if (!result) {
    throw new Error('Failed to verify email');
  }
  return result;
}

export async function setPrimaryEmail(
  db: Db,
  input: { accountId: string; emailId: string; at: string },
): Promise<AccountEmailRow> {
  const target = await db
    .select()
    .from(accountEmails)
    .where(eq(accountEmails.id, input.emailId))
    .limit(1);
  const email = target[0];
  if (email?.accountId !== input.accountId || email.revokedAt != null) {
    throw new IdentityInvariantError('EMAIL_NOT_ACTIVE', 'Email is not active for this account');
  }

  await db
    .update(accountEmails)
    .set({ isPrimary: false, updatedAt: input.at })
    .where(
      and(
        eq(accountEmails.accountId, input.accountId),
        eq(accountEmails.isPrimary, true),
        isNull(accountEmails.revokedAt),
      ),
    );

  const updated = await db
    .update(accountEmails)
    .set({ isPrimary: true, updatedAt: input.at })
    .where(eq(accountEmails.id, input.emailId))
    .returning();
  const result = updated[0];
  if (!result) {
    throw new Error('Failed to set primary email');
  }
  return result;
}

export async function revokeEmail(
  db: Db,
  input: { emailId: string; revokedAt: string },
): Promise<AccountEmailRow> {
  const existing = await db
    .select()
    .from(accountEmails)
    .where(eq(accountEmails.id, input.emailId))
    .limit(1);
  const row = existing[0];
  if (row?.revokedAt != null) {
    throw new IdentityInvariantError('EMAIL_NOT_ACTIVE', 'Email is not active');
  }
  if (!row) {
    throw new IdentityInvariantError('EMAIL_NOT_ACTIVE', 'Email is not active');
  }

  const updated = await db
    .update(accountEmails)
    .set({
      revokedAt: input.revokedAt,
      isPrimary: false,
      updatedAt: input.revokedAt,
    })
    .where(eq(accountEmails.id, input.emailId))
    .returning();
  const result = updated[0];
  if (!result) {
    throw new Error('Failed to revoke email');
  }
  return result;
}

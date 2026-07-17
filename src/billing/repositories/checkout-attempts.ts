import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  stripeCheckoutAttempts,
  type StripeCheckoutAttemptRow,
  type StripeCheckoutAttemptStatus,
} from '../../db/schema.js';

type Db = Database['db'];

export async function insertCheckoutAttempt(
  db: Db,
  input: {
    id: string;
    accountId: string;
    status: StripeCheckoutAttemptStatus;
    createdAt: string;
    expiresAt: string;
  },
): Promise<StripeCheckoutAttemptRow> {
  const rows = await db
    .insert(stripeCheckoutAttempts)
    .values({
      id: input.id,
      accountId: input.accountId,
      stripeCheckoutSessionId: null,
      status: input.status,
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
      completedAt: null,
    })
    .returning();
  const row = rows[0];
  if (!row) {
    throw new Error('Failed to insert Stripe checkout attempt');
  }
  return row;
}

export async function updateCheckoutAttempt(
  db: Db,
  input: {
    id: string;
    status: StripeCheckoutAttemptStatus;
    stripeCheckoutSessionId?: string | null;
    completedAt?: string | null;
  },
): Promise<StripeCheckoutAttemptRow> {
  const update: Partial<StripeCheckoutAttemptRow> = { status: input.status };
  if (input.stripeCheckoutSessionId !== undefined) {
    update.stripeCheckoutSessionId = input.stripeCheckoutSessionId;
  }
  if (input.completedAt !== undefined) {
    update.completedAt = input.completedAt;
  }
  const rows = await db
    .update(stripeCheckoutAttempts)
    .set(update)
    .where(eq(stripeCheckoutAttempts.id, input.id))
    .returning();
  const row = rows[0];
  if (!row) {
    throw new Error('Failed to update Stripe checkout attempt');
  }
  return row;
}

export async function findCheckoutAttemptById(
  db: Db,
  id: string,
): Promise<StripeCheckoutAttemptRow | null> {
  const rows = await db
    .select()
    .from(stripeCheckoutAttempts)
    .where(eq(stripeCheckoutAttempts.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function findCheckoutAttemptBySessionId(
  db: Db,
  stripeCheckoutSessionId: string,
): Promise<StripeCheckoutAttemptRow | null> {
  const rows = await db
    .select()
    .from(stripeCheckoutAttempts)
    .where(eq(stripeCheckoutAttempts.stripeCheckoutSessionId, stripeCheckoutSessionId))
    .limit(1);
  return rows[0] ?? null;
}

export async function findLatestOpenCheckoutAttemptForAccount(
  db: Db,
  input: { accountId: string; now: string },
): Promise<StripeCheckoutAttemptRow | null> {
  const rows = await db.execute<{
    id: string;
    account_id: string;
    stripe_checkout_session_id: string | null;
    status: string;
    created_at: string;
    expires_at: string;
    completed_at: string | null;
  }>(sql`
    SELECT id, account_id, stripe_checkout_session_id, status, created_at, expires_at, completed_at
    FROM town.stripe_checkout_attempts
    WHERE account_id = ${input.accountId}
      AND status IN ('creating', 'open')
      AND expires_at > ${input.now}
    ORDER BY created_at DESC
    LIMIT 1
  `);
  const row = rows.rows[0];
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    accountId: row.account_id,
    stripeCheckoutSessionId: row.stripe_checkout_session_id,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    completedAt: row.completed_at,
  };
}

export async function markCheckoutAttemptStatus(
  db: Db,
  input: {
    accountId: string;
    stripeCheckoutSessionId: string;
    status: StripeCheckoutAttemptStatus;
    completedAt?: string | null;
  },
): Promise<StripeCheckoutAttemptRow | null> {
  const update: Partial<StripeCheckoutAttemptRow> = { status: input.status };
  if (input.completedAt !== undefined) {
    update.completedAt = input.completedAt;
  }
  const rows = await db
    .update(stripeCheckoutAttempts)
    .set(update)
    .where(
      and(
        eq(stripeCheckoutAttempts.accountId, input.accountId),
        eq(stripeCheckoutAttempts.stripeCheckoutSessionId, input.stripeCheckoutSessionId),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

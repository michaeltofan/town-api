import { eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { stripeCustomerLinks, type StripeCustomerLinkRow } from '../../db/schema.js';

type Db = Database['db'];

export async function findCustomerLinkByAccountId(
  db: Db,
  accountId: string,
): Promise<StripeCustomerLinkRow | null> {
  const rows = await db
    .select()
    .from(stripeCustomerLinks)
    .where(eq(stripeCustomerLinks.accountId, accountId))
    .limit(1);
  return rows[0] ?? null;
}

export async function findCustomerLinkByStripeCustomerId(
  db: Db,
  stripeCustomerId: string,
): Promise<StripeCustomerLinkRow | null> {
  const rows = await db
    .select()
    .from(stripeCustomerLinks)
    .where(eq(stripeCustomerLinks.stripeCustomerId, stripeCustomerId))
    .limit(1);
  return rows[0] ?? null;
}

export async function findCustomerLinkByBillingReference(
  db: Db,
  billingReference: string,
): Promise<StripeCustomerLinkRow | null> {
  const rows = await db
    .select()
    .from(stripeCustomerLinks)
    .where(eq(stripeCustomerLinks.billingReference, billingReference))
    .limit(1);
  return rows[0] ?? null;
}

export async function lockCustomerLinkByAccountId(
  db: Db,
  accountId: string,
): Promise<StripeCustomerLinkRow | null> {
  const locked = await db.execute<{
    id: string;
    account_id: string;
    stripe_customer_id: string;
    billing_reference: string;
    created_at: string;
    updated_at: string;
  }>(sql`
    SELECT id, account_id, stripe_customer_id, billing_reference, created_at, updated_at
    FROM town.stripe_customer_links
    WHERE account_id = ${accountId}
    FOR UPDATE
  `);
  const row = locked.rows[0];
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    accountId: row.account_id,
    stripeCustomerId: row.stripe_customer_id,
    billingReference: row.billing_reference,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function insertCustomerLink(
  db: Db,
  input: {
    id: string;
    accountId: string;
    stripeCustomerId: string;
    billingReference: string;
    createdAt: string;
    updatedAt: string;
  },
): Promise<StripeCustomerLinkRow> {
  const rows = await db
    .insert(stripeCustomerLinks)
    .values({
      id: input.id,
      accountId: input.accountId,
      stripeCustomerId: input.stripeCustomerId,
      billingReference: input.billingReference,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    })
    .returning();
  const row = rows[0];
  if (!row) {
    throw new Error('Failed to insert Stripe customer link');
  }
  return row;
}

export function isStripeCustomerLinkUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  const causeMessage =
    error instanceof Error && error.cause instanceof Error ? error.cause.message : '';
  return /stripe_customer_links_(account_id|stripe_customer_id|billing_reference)_unique/i.test(
    `${message}${causeMessage}`,
  );
}

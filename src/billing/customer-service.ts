import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import type { StripeCustomerLinkRow } from '../db/schema.js';
import {
  findCustomerLinkByAccountId,
  insertCustomerLink,
  isStripeCustomerLinkUniqueViolation,
  lockCustomerLinkByAccountId,
} from './repositories/customer-links.js';
import type { TownStripeAdapter } from './stripe-adapter.js';

type Db = Database['db'];

export type EnsureStripeCustomerLinkInput = {
  accountId: string;
  email?: string | null;
  now: string;
  generateId?: () => string;
};

export type EnsureStripeCustomerLinkResult = {
  link: StripeCustomerLinkRow;
  created: boolean;
};

/**
 * Reuse or create a Stripe customer for the given account. Idempotency-key
 * matches the derived `billing_reference` so retries after partial failure
 * return the same customer. Never persists the customer email verbatim beyond
 * the Stripe network call itself.
 */
export async function ensureStripeCustomerLink(
  db: Db,
  adapter: TownStripeAdapter,
  input: EnsureStripeCustomerLinkInput,
): Promise<EnsureStripeCustomerLinkResult> {
  const generateId = input.generateId ?? randomUUID;

  const existing = await findCustomerLinkByAccountId(db, input.accountId);
  if (existing) {
    return { link: existing, created: false };
  }

  return db.transaction(async (tx) => {
    const dbTx = tx as unknown as Db;

    const accountRows = await tx.execute<{ id: string }>(sql`
      SELECT id
      FROM town.accounts
      WHERE id = ${input.accountId}
      FOR UPDATE
    `);
    if (!accountRows.rows[0]) {
      throw new Error('Account not found for Stripe customer link');
    }

    const locked = await lockCustomerLinkByAccountId(dbTx, input.accountId);
    if (locked) {
      return { link: locked, created: false };
    }

    const billingReference = generateId();
    const customer = await adapter.createCustomer(
      {
        ...(input.email !== undefined && input.email !== null ? { email: input.email } : {}),
        metadata: {
          town_account_reference: billingReference,
          town_billing_schema_version: '1',
        },
      },
      { idempotencyKey: `town:create-customer:${billingReference}` },
    );

    try {
      const link = await insertCustomerLink(dbTx, {
        id: generateId(),
        accountId: input.accountId,
        stripeCustomerId: customer.id,
        billingReference,
        createdAt: input.now,
        updatedAt: input.now,
      });
      return { link, created: true };
    } catch (error) {
      if (isStripeCustomerLinkUniqueViolation(error)) {
        const reconciled = await lockCustomerLinkByAccountId(dbTx, input.accountId);
        if (reconciled) {
          return { link: reconciled, created: false };
        }
      }
      throw error;
    }
  });
}

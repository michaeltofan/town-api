import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { appendIdentitySecurityEvent } from '../identity/repositories/security-events.js';
import { lockEntitlementByAccountId } from '../membership/repositories/entitlements.js';
import { ensureStripeCustomerLink } from './customer-service.js';
import { assertAnnualPrice } from './price-policy.js';
import { insertCheckoutAttempt, updateCheckoutAttempt } from './repositories/checkout-attempts.js';
import type { TownStripeAdapter } from './stripe-adapter.js';

type Db = Database['db'];

export type CheckoutServiceError =
  | { code: 'MEMBERSHIP_ALREADY_ACTIVE' }
  | { code: 'BILLING_MANAGE_EXISTING_SUBSCRIPTION' }
  | { code: 'BILLING_CHECKOUT_FAILED'; reason: string }
  | { code: 'BILLING_NOT_AVAILABLE'; reason: string };

export class CheckoutServiceRejection extends Error {
  readonly rejection: CheckoutServiceError;
  constructor(rejection: CheckoutServiceError) {
    super(rejection.code);
    this.name = 'CheckoutServiceRejection';
    this.rejection = rejection;
  }
}

export type CheckoutConfig = {
  priceId: string;
  successUrl: string;
  cancelUrl: string;
  expectedLivemode: boolean;
};

export type CreateCheckoutSessionInput = {
  accountId: string;
  accountEmail?: string | null;
  now: string;
  generateId?: () => string;
  requestId?: string | null;
};

export type CreateCheckoutSessionResult = {
  checkoutUrl: string;
  attemptId: string;
};

const CHECKOUT_ATTEMPT_TTL_MS = 30 * 60_000;

/**
 * Creates a Checkout Session for the caller account under strict guards:
 *  - price policy is validated against Stripe (safe out-of-transaction call).
 *  - customer link is reused or created (idempotency-key bound to billing_reference).
 *  - Account/entitlement rows are locked; existing active/cancelling subscriptions
 *    block Checkout with domain error codes rather than Stripe's URL.
 *  - Attempt row is persisted before Stripe is called so partial failures reconcile.
 *  - Stripe idempotency-key `town:checkout:<billing-reference>:<attempt-id>`.
 * The response body exposes only the Stripe-issued checkoutUrl.
 */
export async function createCheckoutSessionForAccount(
  db: Db,
  adapter: TownStripeAdapter,
  config: CheckoutConfig,
  input: CreateCheckoutSessionInput,
): Promise<CreateCheckoutSessionResult> {
  const generateId = input.generateId ?? randomUUID;

  const price = await adapter.retrievePrice(config.priceId);
  const validated = assertAnnualPrice(price, config.priceId);
  if (!validated.ok) {
    throw new CheckoutServiceRejection({
      code: 'BILLING_NOT_AVAILABLE',
      reason: `price_${validated.reason}`,
    });
  }
  if (price.livemode !== config.expectedLivemode) {
    throw new CheckoutServiceRejection({
      code: 'BILLING_NOT_AVAILABLE',
      reason: 'livemode_mismatch',
    });
  }

  const { link } = await ensureStripeCustomerLink(db, adapter, {
    accountId: input.accountId,
    ...(input.accountEmail !== undefined ? { email: input.accountEmail } : {}),
    now: input.now,
    generateId,
  });

  return db.transaction(async (tx) => {
    const dbTx = tx as unknown as Db;

    const accountRows = await tx.execute<{ id: string; status: string }>(sql`
      SELECT id, status
      FROM town.accounts
      WHERE id = ${input.accountId}
      FOR UPDATE
    `);
    const account = accountRows.rows[0];
    if (!account) {
      throw new CheckoutServiceRejection({
        code: 'BILLING_CHECKOUT_FAILED',
        reason: 'account_missing',
      });
    }
    if (account.status !== 'active') {
      throw new CheckoutServiceRejection({
        code: 'BILLING_CHECKOUT_FAILED',
        reason: 'account_not_active',
      });
    }

    const entitlement = await lockEntitlementByAccountId(dbTx, input.accountId);
    const nowMs = new Date(input.now).getTime();

    if (entitlement) {
      const accessUntilMs = entitlement.accessUntil
        ? new Date(entitlement.accessUntil).getTime()
        : null;
      if (entitlement.status === 'active') {
        throw new CheckoutServiceRejection({ code: 'MEMBERSHIP_ALREADY_ACTIVE' });
      }
      if (entitlement.status === 'cancelling' && accessUntilMs !== null && accessUntilMs > nowMs) {
        throw new CheckoutServiceRejection({
          code: 'BILLING_MANAGE_EXISTING_SUBSCRIPTION',
        });
      }
      if (
        entitlement.source === 'stripe' &&
        entitlement.sourceSubscriptionId &&
        entitlement.status !== 'expired'
      ) {
        try {
          const subscription = await adapter.retrieveSubscription(entitlement.sourceSubscriptionId);
          if (subscription.status === 'active' || subscription.status === 'trialing') {
            throw new CheckoutServiceRejection({
              code: 'BILLING_MANAGE_EXISTING_SUBSCRIPTION',
            });
          }
        } catch (error) {
          if (error instanceof CheckoutServiceRejection) {
            throw error;
          }
          // If Stripe cannot confirm the subscription we still allow Checkout; the
          // entitlement will be reconciled from webhooks.
        }
      }
    }

    const attemptId = generateId();
    const expiresAt = new Date(nowMs + CHECKOUT_ATTEMPT_TTL_MS).toISOString();
    await insertCheckoutAttempt(dbTx, {
      id: attemptId,
      accountId: input.accountId,
      status: 'creating',
      createdAt: input.now,
      expiresAt,
    });

    const idempotencyKey = `town:checkout:${link.billingReference}:${attemptId}`;
    let session;
    try {
      session = await adapter.createCheckoutSession(
        {
          mode: 'subscription',
          customer: link.stripeCustomerId,
          line_items: [{ price: config.priceId, quantity: 1 }],
          success_url: config.successUrl,
          cancel_url: config.cancelUrl,
          client_reference_id: link.billingReference,
          metadata: {
            town_account_reference: link.billingReference,
            town_checkout_attempt_id: attemptId,
            town_billing_schema_version: '1',
          },
          subscription_data: {
            metadata: {
              town_account_reference: link.billingReference,
              town_billing_schema_version: '1',
            },
          },
          allow_promotion_codes: false,
        },
        { idempotencyKey },
      );
    } catch (error) {
      await updateCheckoutAttempt(dbTx, {
        id: attemptId,
        status: 'failed',
      });
      throw new CheckoutServiceRejection({
        code: 'BILLING_CHECKOUT_FAILED',
        reason: error instanceof Error ? 'stripe_error' : 'unknown',
      });
    }

    if (!session.url) {
      await updateCheckoutAttempt(dbTx, {
        id: attemptId,
        status: 'failed',
      });
      throw new CheckoutServiceRejection({
        code: 'BILLING_CHECKOUT_FAILED',
        reason: 'missing_session_url',
      });
    }

    await updateCheckoutAttempt(dbTx, {
      id: attemptId,
      status: 'open',
      stripeCheckoutSessionId: session.id,
    });

    await appendIdentitySecurityEvent(dbTx, {
      id: generateId(),
      accountId: input.accountId,
      eventType: 'stripe_checkout_session_created',
      occurredAt: input.now,
      requestId: input.requestId ?? null,
      metadata: {
        checkoutAttemptId: attemptId,
        mode: 'subscription',
      },
    });

    return { checkoutUrl: session.url, attemptId };
  });
}

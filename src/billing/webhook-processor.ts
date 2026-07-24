import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type Stripe from 'stripe';
import type { Database } from '../db/client.js';
import type { IdentitySecurityEventType } from '../db/schema.js';
import { appendIdentitySecurityEvent } from '../identity/repositories/security-events.js';
import {
  lockEntitlementByAccountId,
  updateMembershipEntitlement,
} from '../membership/repositories/entitlements.js';
import { activateMembership } from '../membership/transitions/activate.js';
import { expireMembership } from '../membership/transitions/expire.js';
import { reactivateMembership } from '../membership/transitions/reactivate.js';
import { scheduleMembershipCancellation } from '../membership/transitions/schedule-cancellation.js';
import type { MembershipTransitionOutcome } from '../membership/transitions/shared.js';
import { assertAnnualPrice } from './price-policy.js';
import { findCustomerLinkByStripeCustomerId } from './repositories/customer-links.js';
import { markCheckoutAttemptStatus } from './repositories/checkout-attempts.js';
import { STRIPE_API_VERSION } from './stripe-adapter.js';
import type { TownStripeAdapter } from './stripe-adapter.js';

type Db = Database['db'];

/**
 * Result of processing one already signature-verified Stripe event.
 * Route layer maps this to an HTTP status code and JSON body.
 */
export type WebhookProcessorResult =
  | { kind: 'applied'; eventType: string }
  | { kind: 'replayed'; eventType: string }
  | { kind: 'ignored'; eventType: string; reason: string }
  | { kind: 'rejected'; eventType: string; reason: string; recoverable: boolean };

export type WebhookProcessorConfig = {
  priceId: string;
  expectedLivemode: boolean;
  nodeEnv: string;
};

export type WebhookProcessorDeps = {
  db: Db;
  adapter: TownStripeAdapter;
  config: WebhookProcessorConfig;
  now: () => string;
  generateId?: () => string;
  requestId?: string | null;
};

const PROCESSED_EVENT_TYPES = new Set<string>([
  'checkout.session.completed',
  'invoice.paid',
  'invoice.payment_failed',
  'customer.subscription.updated',
  'customer.subscription.deleted',
]);

function typedStripeSubscription(value: unknown): Stripe.Subscription | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  if ((value as { object?: string }).object === 'subscription') {
    return value as Stripe.Subscription;
  }
  return null;
}

function typedStripeInvoice(value: unknown): Stripe.Invoice | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  if ((value as { object?: string }).object === 'invoice') {
    return value as Stripe.Invoice;
  }
  return null;
}

function typedStripeCheckoutSession(value: unknown): Stripe.Checkout.Session | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  if ((value as { object?: string }).object === 'checkout.session') {
    return value as Stripe.Checkout.Session;
  }
  return null;
}

function extractCustomerId(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  if (value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string') {
    return (value as { id: string }).id;
  }
  return null;
}

function extractPriceIdFromSubscription(subscription: Stripe.Subscription): string | null {
  const items = subscription.items.data;
  if (items.length !== 1) {
    return null;
  }
  const first = items[0];
  if (!first) {
    return null;
  }
  const price = first.price;
  return typeof price === 'object' ? price.id : null;
}

function extractCurrentPeriodEnd(subscription: Stripe.Subscription): number | null {
  const items = subscription.items.data;
  const timestamps: number[] = [];
  for (const item of items) {
    const ts = (item as { current_period_end?: number }).current_period_end;
    if (typeof ts === 'number' && Number.isFinite(ts)) {
      timestamps.push(ts);
    }
  }
  const top = (subscription as unknown as { current_period_end?: number }).current_period_end;
  if (typeof top === 'number' && Number.isFinite(top)) {
    timestamps.push(top);
  }
  if (timestamps.length === 0) {
    return null;
  }
  return Math.max(...timestamps);
}

function extractCancelAtPeriodEnd(subscription: Stripe.Subscription): boolean {
  return Boolean((subscription as { cancel_at_period_end?: boolean }).cancel_at_period_end);
}

async function auditStripeEvent(
  db: Db,
  input: {
    accountId: string | null;
    eventType: IdentitySecurityEventType;
    now: string;
    requestId: string | null;
    generateId: () => string;
    metadata: Record<string, string | boolean | number | null>;
  },
): Promise<void> {
  await appendIdentitySecurityEvent(db, {
    id: input.generateId(),
    accountId: input.accountId,
    eventType: input.eventType,
    occurredAt: input.now,
    requestId: input.requestId,
    metadata: input.metadata,
  });
}

/**
 * Look up the TOWN account associated with a Stripe customer id, or null.
 */
async function reconcileAccountId(db: Db, customerId: string | null): Promise<string | null> {
  if (!customerId) {
    return null;
  }
  const link = await findCustomerLinkByStripeCustomerId(db, customerId);
  return link ? link.accountId : null;
}

function transitionOutcomeToWebhookResult(
  outcome: MembershipTransitionOutcome,
  eventType: string,
): WebhookProcessorResult {
  switch (outcome.result) {
    case 'applied':
      return { kind: 'applied', eventType };
    case 'replayed':
      return { kind: 'replayed', eventType };
    case 'stale':
      return { kind: 'ignored', eventType, reason: outcome.reason ?? 'stale' };
    case 'rejected':
      return {
        kind: 'rejected',
        eventType,
        reason: outcome.reason ?? 'rejected',
        recoverable: false,
      };
  }
}

export async function processStripeWebhookEvent(
  deps: WebhookProcessorDeps,
  event: Stripe.Event,
): Promise<WebhookProcessorResult> {
  const { db, config } = deps;
  const generateId = deps.generateId ?? randomUUID;
  const now = deps.now();
  const requestId = deps.requestId ?? null;

  await auditStripeEvent(db, {
    accountId: null,
    eventType: 'stripe_webhook_received',
    now,
    requestId,
    generateId,
    metadata: {
      stripeEventType: event.type,
      apiVersion: event.api_version ?? null,
    },
  });

  if (event.api_version && event.api_version !== STRIPE_API_VERSION) {
    await auditStripeEvent(db, {
      accountId: null,
      eventType: 'stripe_webhook_rejected',
      now,
      requestId,
      generateId,
      metadata: {
        stripeEventType: event.type,
        reason: 'api_version_mismatch',
      },
    });
    return {
      kind: 'rejected',
      eventType: event.type,
      reason: 'api_version_mismatch',
      recoverable: false,
    };
  }

  if (event.livemode !== config.expectedLivemode) {
    await auditStripeEvent(db, {
      accountId: null,
      eventType: 'stripe_webhook_rejected',
      now,
      requestId,
      generateId,
      metadata: {
        stripeEventType: event.type,
        reason: 'livemode_mismatch',
      },
    });
    return {
      kind: 'rejected',
      eventType: event.type,
      reason: 'livemode_mismatch',
      recoverable: false,
    };
  }

  if (!PROCESSED_EVENT_TYPES.has(event.type)) {
    return { kind: 'ignored', eventType: event.type, reason: 'unhandled_event_type' };
  }

  await auditStripeEvent(db, {
    accountId: null,
    eventType: 'stripe_webhook_verified',
    now,
    requestId,
    generateId,
    metadata: {
      stripeEventType: event.type,
    },
  });

  switch (event.type) {
    case 'checkout.session.completed':
      return handleCheckoutSessionCompleted(deps, event, now, generateId, requestId);
    case 'invoice.paid':
      return handleInvoicePaid(deps, event, now, generateId, requestId);
    case 'invoice.payment_failed':
      return handleInvoicePaymentFailed(deps, event, now, generateId, requestId);
    case 'customer.subscription.updated':
      return handleSubscriptionUpdated(deps, event, now, generateId, requestId);
    case 'customer.subscription.deleted':
      return handleSubscriptionDeleted(deps, event, now, generateId, requestId);
    default:
      return { kind: 'ignored', eventType: event.type, reason: 'unhandled_event_type' };
  }
}

async function handleCheckoutSessionCompleted(
  deps: WebhookProcessorDeps,
  event: Stripe.Event,
  now: string,
  generateId: () => string,
  requestId: string | null,
): Promise<WebhookProcessorResult> {
  const session = typedStripeCheckoutSession(event.data.object);
  if (!session) {
    return {
      kind: 'rejected',
      eventType: event.type,
      reason: 'unexpected_object',
      recoverable: false,
    };
  }
  const customerId = extractCustomerId(session.customer);
  const subscriptionRef = session.subscription;
  const subscriptionId =
    typeof subscriptionRef === 'string'
      ? subscriptionRef
      : subscriptionRef && typeof subscriptionRef === 'object'
        ? subscriptionRef.id
        : null;
  const accountId = await reconcileAccountId(deps.db, customerId);
  if (!accountId) {
    await auditStripeEvent(deps.db, {
      accountId: null,
      eventType: 'stripe_webhook_rejected',
      now,
      requestId,
      generateId,
      metadata: { stripeEventType: event.type, reason: 'account_unresolved' },
    });
    return {
      kind: 'rejected',
      eventType: event.type,
      reason: 'account_unresolved',
      recoverable: true,
    };
  }

  if (session.status !== 'complete' || session.payment_status === 'unpaid') {
    return { kind: 'ignored', eventType: event.type, reason: 'session_not_complete' };
  }

  // Update Stripe reference on the customer link is unnecessary (already linked).
  // Link the subscription reference on the entitlement without activating; invoice.paid drives activation.
  await deps.db.transaction(async (tx) => {
    const dbTx = tx as unknown as Db;
    await dbTx.execute(sql`
      SELECT id
      FROM town.accounts
      WHERE id = ${accountId}
      FOR KEY SHARE
    `);
    const entitlement = await lockEntitlementByAccountId(dbTx, accountId);
    if (entitlement && subscriptionId && entitlement.sourceSubscriptionId !== subscriptionId) {
      await updateMembershipEntitlement(dbTx, {
        id: entitlement.id,
        status: entitlement.status,
        accessUntil: entitlement.accessUntil,
        cancelAtPeriodEnd: entitlement.cancelAtPeriodEnd,
        source: entitlement.source as import('../db/schema.js').MembershipSource,
        sourceCustomerId: entitlement.sourceCustomerId ?? customerId,
        sourceSubscriptionId: subscriptionId,
        activatedAt: entitlement.activatedAt,
        cancellationRequestedAt: entitlement.cancellationRequestedAt,
        expiredAt: entitlement.expiredAt,
        updatedAt: now,
        version: entitlement.version + 1,
      });
    }

    await auditStripeEvent(dbTx, {
      accountId,
      eventType: 'stripe_subscription_linked',
      now,
      requestId,
      generateId,
      metadata: { hasSubscription: subscriptionId !== null },
    });

    if (session.id) {
      await markCheckoutAttemptStatus(dbTx, {
        accountId,
        stripeCheckoutSessionId: session.id,
        status: 'completed',
        completedAt: now,
      });
    }
  });

  return { kind: 'applied', eventType: event.type };
}

async function handleInvoicePaid(
  deps: WebhookProcessorDeps,
  event: Stripe.Event,
  now: string,
  generateId: () => string,
  requestId: string | null,
): Promise<WebhookProcessorResult> {
  const invoice = typedStripeInvoice(event.data.object);
  if (!invoice) {
    return {
      kind: 'rejected',
      eventType: event.type,
      reason: 'unexpected_object',
      recoverable: false,
    };
  }

  const customerId = extractCustomerId(invoice.customer);
  const accountId = await reconcileAccountId(deps.db, customerId);
  if (!accountId) {
    await auditStripeEvent(deps.db, {
      accountId: null,
      eventType: 'stripe_webhook_rejected',
      now,
      requestId,
      generateId,
      metadata: { stripeEventType: event.type, reason: 'account_unresolved' },
    });
    return {
      kind: 'rejected',
      eventType: event.type,
      reason: 'account_unresolved',
      recoverable: true,
    };
  }

  // Determine the invoice subscription. Retrieve authoritatively out of transaction.
  const parent = invoice as unknown as {
    parent?: { subscription_details?: { subscription?: string } | null } | null;
    subscription?: string | { id: string } | null;
  };
  const subscriptionIdCandidate =
    typeof parent.subscription === 'string'
      ? parent.subscription
      : parent.subscription && typeof parent.subscription === 'object'
        ? parent.subscription.id
        : (parent.parent?.subscription_details?.subscription ?? null);
  if (!subscriptionIdCandidate) {
    await auditStripeEvent(deps.db, {
      accountId,
      eventType: 'stripe_webhook_rejected',
      now,
      requestId,
      generateId,
      metadata: { stripeEventType: event.type, reason: 'invoice_missing_subscription' },
    });
    return { kind: 'ignored', eventType: event.type, reason: 'invoice_missing_subscription' };
  }

  const subscription = await deps.adapter.retrieveSubscription(subscriptionIdCandidate);
  const priceId = extractPriceIdFromSubscription(subscription);
  if (!priceId || priceId !== deps.config.priceId) {
    await auditStripeEvent(deps.db, {
      accountId,
      eventType: 'stripe_price_mismatch',
      now,
      requestId,
      generateId,
      metadata: {
        stripeEventType: event.type,
        reason: 'unknown_price',
      },
    });
    return {
      kind: 'rejected',
      eventType: event.type,
      reason: 'price_mismatch',
      recoverable: false,
    };
  }
  const price = subscription.items.data[0]?.price;
  if (price) {
    const priceValidation = assertAnnualPrice(price, deps.config.priceId);
    if (!priceValidation.ok) {
      await auditStripeEvent(deps.db, {
        accountId,
        eventType: 'stripe_price_mismatch',
        now,
        requestId,
        generateId,
        metadata: { stripeEventType: event.type, reason: `price_${priceValidation.reason}` },
      });
      return {
        kind: 'rejected',
        eventType: event.type,
        reason: 'price_mismatch',
        recoverable: false,
      };
    }
  }

  const currentPeriodEnd = extractCurrentPeriodEnd(subscription);
  if (currentPeriodEnd === null) {
    await auditStripeEvent(deps.db, {
      accountId,
      eventType: 'stripe_webhook_rejected',
      now,
      requestId,
      generateId,
      metadata: { stripeEventType: event.type, reason: 'missing_current_period_end' },
    });
    return {
      kind: 'rejected',
      eventType: event.type,
      reason: 'missing_current_period_end',
      recoverable: false,
    };
  }
  const accessUntil = new Date(currentPeriodEnd * 1000).toISOString();

  const outcome = await activateMembership(
    deps.db,
    {
      source: 'stripe',
      sourceEventId: event.id,
      eventType: 'activate',
      accountId,
      effectiveAt: now,
      accessUntil,
      sourceCustomerId: customerId,
      sourceSubscriptionId: subscription.id,
    },
    {
      nodeEnv: deps.config.nodeEnv,
      processedAt: now,
      requestId,
    },
  );

  if (outcome.result === 'applied') {
    await auditStripeEvent(deps.db, {
      accountId,
      eventType: 'stripe_invoice_paid',
      now,
      requestId,
      generateId,
      metadata: {
        stripeEventType: event.type,
      },
    });
  } else if (outcome.result === 'replayed') {
    await auditStripeEvent(deps.db, {
      accountId,
      eventType: 'stripe_webhook_replayed',
      now,
      requestId,
      generateId,
      metadata: { stripeEventType: event.type },
    });
  }
  return transitionOutcomeToWebhookResult(outcome, event.type);
}

async function handleInvoicePaymentFailed(
  deps: WebhookProcessorDeps,
  event: Stripe.Event,
  now: string,
  generateId: () => string,
  requestId: string | null,
): Promise<WebhookProcessorResult> {
  const invoice = typedStripeInvoice(event.data.object);
  if (!invoice) {
    return {
      kind: 'rejected',
      eventType: event.type,
      reason: 'unexpected_object',
      recoverable: false,
    };
  }
  const customerId = extractCustomerId(invoice.customer);
  const accountId = await reconcileAccountId(deps.db, customerId);
  if (!accountId) {
    return { kind: 'ignored', eventType: event.type, reason: 'account_unresolved' };
  }

  await auditStripeEvent(deps.db, {
    accountId,
    eventType: 'stripe_payment_failed',
    now,
    requestId,
    generateId,
    metadata: { stripeEventType: event.type },
  });
  return { kind: 'applied', eventType: event.type };
}

async function handleSubscriptionUpdated(
  deps: WebhookProcessorDeps,
  event: Stripe.Event,
  now: string,
  generateId: () => string,
  requestId: string | null,
): Promise<WebhookProcessorResult> {
  const subscription = typedStripeSubscription(event.data.object);
  if (!subscription) {
    return {
      kind: 'rejected',
      eventType: event.type,
      reason: 'unexpected_object',
      recoverable: false,
    };
  }
  const customerId = extractCustomerId(subscription.customer);
  const accountId = await reconcileAccountId(deps.db, customerId);
  if (!accountId) {
    return {
      kind: 'rejected',
      eventType: event.type,
      reason: 'account_unresolved',
      recoverable: true,
    };
  }

  // Reject unsupported changes.
  const items = subscription.items.data;
  if (items.length !== 1) {
    await auditStripeEvent(deps.db, {
      accountId,
      eventType: 'stripe_webhook_rejected',
      now,
      requestId,
      generateId,
      metadata: { stripeEventType: event.type, reason: 'unsupported_multi_line' },
    });
    return {
      kind: 'rejected',
      eventType: event.type,
      reason: 'unsupported_multi_line',
      recoverable: false,
    };
  }
  const item = items[0];
  if (item?.quantity !== 1) {
    await auditStripeEvent(deps.db, {
      accountId,
      eventType: 'stripe_webhook_rejected',
      now,
      requestId,
      generateId,
      metadata: { stripeEventType: event.type, reason: 'unsupported_quantity' },
    });
    return {
      kind: 'rejected',
      eventType: event.type,
      reason: 'unsupported_quantity',
      recoverable: false,
    };
  }
  const priceId = extractPriceIdFromSubscription(subscription);
  if (!priceId || priceId !== deps.config.priceId) {
    await auditStripeEvent(deps.db, {
      accountId,
      eventType: 'stripe_price_mismatch',
      now,
      requestId,
      generateId,
      metadata: { stripeEventType: event.type, reason: 'unknown_price' },
    });
    return {
      kind: 'rejected',
      eventType: event.type,
      reason: 'price_mismatch',
      recoverable: false,
    };
  }
  if (subscription.pause_collection) {
    await auditStripeEvent(deps.db, {
      accountId,
      eventType: 'stripe_webhook_rejected',
      now,
      requestId,
      generateId,
      metadata: { stripeEventType: event.type, reason: 'unsupported_pause' },
    });
    return {
      kind: 'rejected',
      eventType: event.type,
      reason: 'unsupported_pause',
      recoverable: false,
    };
  }
  if (subscription.status === 'trialing' || subscription.trial_end) {
    await auditStripeEvent(deps.db, {
      accountId,
      eventType: 'stripe_webhook_rejected',
      now,
      requestId,
      generateId,
      metadata: { stripeEventType: event.type, reason: 'unsupported_trial' },
    });
    return {
      kind: 'rejected',
      eventType: event.type,
      reason: 'unsupported_trial',
      recoverable: false,
    };
  }

  const cancelAtPeriodEnd = extractCancelAtPeriodEnd(subscription);
  const outcome = cancelAtPeriodEnd
    ? await scheduleMembershipCancellation(
        deps.db,
        {
          source: 'stripe',
          sourceEventId: event.id,
          eventType: 'schedule_cancellation',
          accountId,
          effectiveAt: now,
          sourceCustomerId: customerId,
          sourceSubscriptionId: subscription.id,
          cancelAtPeriodEnd: true,
        },
        {
          nodeEnv: deps.config.nodeEnv,
          processedAt: now,
          requestId,
        },
      )
    : await reactivateMembership(
        deps.db,
        {
          source: 'stripe',
          sourceEventId: event.id,
          eventType: 'reactivate',
          accountId,
          effectiveAt: now,
          sourceCustomerId: customerId,
          sourceSubscriptionId: subscription.id,
          cancelAtPeriodEnd: false,
        },
        {
          nodeEnv: deps.config.nodeEnv,
          processedAt: now,
          requestId,
        },
      );

  if (outcome.result === 'applied') {
    await auditStripeEvent(deps.db, {
      accountId,
      eventType: cancelAtPeriodEnd
        ? 'stripe_cancellation_scheduled'
        : 'stripe_cancellation_removed',
      now,
      requestId,
      generateId,
      metadata: { stripeEventType: event.type },
    });
  } else if (outcome.result === 'replayed') {
    await auditStripeEvent(deps.db, {
      accountId,
      eventType: 'stripe_webhook_replayed',
      now,
      requestId,
      generateId,
      metadata: { stripeEventType: event.type },
    });
  }
  return transitionOutcomeToWebhookResult(outcome, event.type);
}

async function handleSubscriptionDeleted(
  deps: WebhookProcessorDeps,
  event: Stripe.Event,
  now: string,
  generateId: () => string,
  requestId: string | null,
): Promise<WebhookProcessorResult> {
  const subscription = typedStripeSubscription(event.data.object);
  if (!subscription) {
    return {
      kind: 'rejected',
      eventType: event.type,
      reason: 'unexpected_object',
      recoverable: false,
    };
  }
  const customerId = extractCustomerId(subscription.customer);
  const accountId = await reconcileAccountId(deps.db, customerId);
  if (!accountId) {
    return {
      kind: 'rejected',
      eventType: event.type,
      reason: 'account_unresolved',
      recoverable: true,
    };
  }

  // Look up the current entitlement to decide expire vs preserve.
  const entitlement = await deps.db.transaction(async (tx) => {
    return lockEntitlementByAccountId(tx, accountId);
  });
  const nowMs = new Date(now).getTime();
  const accessUntilMs = entitlement?.accessUntil
    ? new Date(entitlement.accessUntil).getTime()
    : null;

  if (accessUntilMs !== null && accessUntilMs <= nowMs) {
    const outcome = await expireMembership(
      deps.db,
      {
        source: 'stripe',
        sourceEventId: event.id,
        eventType: 'expire',
        accountId,
        effectiveAt: now,
        sourceCustomerId: customerId,
        sourceSubscriptionId: subscription.id,
      },
      {
        nodeEnv: deps.config.nodeEnv,
        processedAt: now,
        requestId,
      },
    );
    if (outcome.result === 'applied') {
      await auditStripeEvent(deps.db, {
        accountId,
        eventType: 'stripe_subscription_deleted',
        now,
        requestId,
        generateId,
        metadata: { stripeEventType: event.type, transition: 'expired' },
      });
    } else if (outcome.result === 'replayed') {
      await auditStripeEvent(deps.db, {
        accountId,
        eventType: 'stripe_webhook_replayed',
        now,
        requestId,
        generateId,
        metadata: { stripeEventType: event.type },
      });
    }
    return transitionOutcomeToWebhookResult(outcome, event.type);
  }

  // Preserve access; audit only.
  await auditStripeEvent(deps.db, {
    accountId,
    eventType: 'stripe_subscription_deleted',
    now,
    requestId,
    generateId,
    metadata: { stripeEventType: event.type, transition: 'preserved' },
  });
  return { kind: 'applied', eventType: event.type };
}

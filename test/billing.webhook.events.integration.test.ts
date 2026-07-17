import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import { activatePasskeyAccountAndLinkCommunity } from './helpers/membership.js';
import {
  buildSignedWebhookRequest,
  createBillingTestApp,
  primeInvoice,
  primeSubscription,
  TEST_STRIPE_ANNUAL_PRICE_ID,
  type BillingTestApp,
} from './helpers/billing.js';
import { loginMobileSession } from './helpers/passkey-management.js';
import { membershipEntitlements } from '../src/db/schema.js';
import { insertCustomerLink } from '../src/billing/repositories/customer-links.js';
import { randomUUID } from 'node:crypto';

async function seedCustomerLink(
  ctx: BillingTestApp,
  accountId: string,
): Promise<{ customerId: string; billingReference: string }> {
  const customerId = `cus_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const billingReference = randomUUID();
  await insertCustomerLink(ctx.app.database.db, {
    id: randomUUID(),
    accountId,
    stripeCustomerId: customerId,
    billingReference,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return { customerId, billingReference };
}

async function postSignedWebhook(
  ctx: BillingTestApp,
  input: Parameters<typeof buildSignedWebhookRequest>[0],
) {
  const { rawBody, signature } = buildSignedWebhookRequest(input);
  return ctx.app.inject({
    method: 'POST',
    url: '/v1/billing/stripe/webhook',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': signature,
    },
    payload: rawBody,
  });
}

describe('POST /v1/billing/stripe/webhook — event handling', () => {
  let ctx: BillingTestApp;

  beforeAll(async () => {
    ctx = await createBillingTestApp();
  });

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  it('invoice.paid activates the account membership with accessUntil derived from current_period_end', async () => {
    const registration = await activatePasskeyAccountAndLinkCommunity({
      app: ctx.app,
      delivery: ctx.delivery,
      email: 'WebhookInvoicePaid+setup@example.com',
    });
    const { customerId } = await seedCustomerLink(ctx, registration.accountId);
    const currentPeriodEnd = Math.floor(new Date('2030-01-01T00:00:00.000Z').getTime() / 1000);
    const subscription = primeSubscription(ctx.stripeState, {
      customerId,
      priceId: TEST_STRIPE_ANNUAL_PRICE_ID,
      currentPeriodEnd,
      status: 'active',
    });
    const invoice = primeInvoice(ctx.stripeState, {
      customerId,
      subscriptionId: subscription.id,
    });

    const response = await postSignedWebhook(ctx, {
      eventType: 'invoice.paid',
      data: invoice as unknown as Record<string, unknown>,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });

    const entitlement = (
      await ctx.app.database.db
        .select()
        .from(membershipEntitlements)
        .where(eq(membershipEntitlements.accountId, registration.accountId))
        .limit(1)
    )[0];
    expect(entitlement?.status).toBe('active');
    expect(new Date(entitlement?.accessUntil ?? 0).toISOString()).toBe('2030-01-01T00:00:00.000Z');
    expect(entitlement?.source).toBe('stripe');
    expect(entitlement?.sourceSubscriptionId).toBe(subscription.id);
  });

  it('invoice.paid is idempotent (same event id replays without a version bump)', async () => {
    const registration = await activatePasskeyAccountAndLinkCommunity({
      app: ctx.app,
      delivery: ctx.delivery,
      email: 'WebhookInvoicePaidIdempotent+setup@example.com',
    });
    const { customerId } = await seedCustomerLink(ctx, registration.accountId);
    const currentPeriodEnd = Math.floor(new Date('2030-01-01T00:00:00.000Z').getTime() / 1000);
    const subscription = primeSubscription(ctx.stripeState, {
      customerId,
      priceId: TEST_STRIPE_ANNUAL_PRICE_ID,
      currentPeriodEnd,
      status: 'active',
    });
    const invoice = primeInvoice(ctx.stripeState, {
      customerId,
      subscriptionId: subscription.id,
    });
    const eventId = `evt_${randomUUID().replace(/-/g, '')}`;

    const first = await postSignedWebhook(ctx, {
      eventId,
      eventType: 'invoice.paid',
      data: invoice as unknown as Record<string, unknown>,
    });
    expect(first.statusCode).toBe(200);
    const versionAfterFirst = (
      await ctx.app.database.db
        .select()
        .from(membershipEntitlements)
        .where(eq(membershipEntitlements.accountId, registration.accountId))
        .limit(1)
    )[0]?.version;

    const second = await postSignedWebhook(ctx, {
      eventId,
      eventType: 'invoice.paid',
      data: invoice as unknown as Record<string, unknown>,
    });
    expect(second.statusCode).toBe(200);
    const versionAfterSecond = (
      await ctx.app.database.db
        .select()
        .from(membershipEntitlements)
        .where(eq(membershipEntitlements.accountId, registration.accountId))
        .limit(1)
    )[0]?.version;
    expect(versionAfterSecond).toBe(versionAfterFirst);
  });

  it('rejects invoice.paid when the price is not the pinned annual price', async () => {
    const registration = await activatePasskeyAccountAndLinkCommunity({
      app: ctx.app,
      delivery: ctx.delivery,
      email: 'WebhookInvoicePriceMismatch+setup@example.com',
    });
    const { customerId } = await seedCustomerLink(ctx, registration.accountId);
    const subscription = primeSubscription(ctx.stripeState, {
      customerId,
      priceId: 'price_wrong_membership_tier',
      currentPeriodEnd: Math.floor(Date.now() / 1000) + 3600,
      status: 'active',
    });
    const invoice = primeInvoice(ctx.stripeState, {
      customerId,
      subscriptionId: subscription.id,
    });

    const response = await postSignedWebhook(ctx, {
      eventType: 'invoice.paid',
      data: invoice as unknown as Record<string, unknown>,
    });
    // Route surfaces 200 for structural rejection (Stripe should not retry).
    expect(response.statusCode).toBe(200);
    const entitlement = (
      await ctx.app.database.db
        .select()
        .from(membershipEntitlements)
        .where(eq(membershipEntitlements.accountId, registration.accountId))
        .limit(1)
    )[0];
    expect(entitlement).toBeUndefined();
  });

  it('rejects events whose livemode does not match STRIPE_EXPECTED_LIVEMODE', async () => {
    const registration = await activatePasskeyAccountAndLinkCommunity({
      app: ctx.app,
      delivery: ctx.delivery,
      email: 'WebhookLivemode+setup@example.com',
    });
    const { customerId } = await seedCustomerLink(ctx, registration.accountId);
    const subscription = primeSubscription(ctx.stripeState, {
      customerId,
      priceId: TEST_STRIPE_ANNUAL_PRICE_ID,
      currentPeriodEnd: Math.floor(Date.now() / 1000) + 3600,
      status: 'active',
    });
    const invoice = primeInvoice(ctx.stripeState, {
      customerId,
      subscriptionId: subscription.id,
    });

    const response = await postSignedWebhook(ctx, {
      eventType: 'invoice.paid',
      data: invoice as unknown as Record<string, unknown>,
      livemode: true,
    });
    expect(response.statusCode).toBe(200);
    const entitlement = (
      await ctx.app.database.db
        .select()
        .from(membershipEntitlements)
        .where(eq(membershipEntitlements.accountId, registration.accountId))
        .limit(1)
    )[0];
    expect(entitlement).toBeUndefined();
  });

  it('customer.subscription.updated with cancel_at_period_end=true schedules cancellation', async () => {
    const registration = await activatePasskeyAccountAndLinkCommunity({
      app: ctx.app,
      delivery: ctx.delivery,
      email: 'WebhookCancel+setup@example.com',
    });
    const { customerId } = await seedCustomerLink(ctx, registration.accountId);
    const currentPeriodEnd = Math.floor(new Date('2030-01-01T00:00:00.000Z').getTime() / 1000);
    const subscription = primeSubscription(ctx.stripeState, {
      customerId,
      priceId: TEST_STRIPE_ANNUAL_PRICE_ID,
      currentPeriodEnd,
      status: 'active',
    });
    const invoice = primeInvoice(ctx.stripeState, {
      customerId,
      subscriptionId: subscription.id,
    });
    // First activate the membership so scheduling cancellation has a target.
    await postSignedWebhook(ctx, {
      eventType: 'invoice.paid',
      data: invoice as unknown as Record<string, unknown>,
    });

    const updated = {
      ...(subscription as unknown as Record<string, unknown>),
      cancel_at_period_end: true,
    };
    const response = await postSignedWebhook(ctx, {
      eventType: 'customer.subscription.updated',
      data: updated,
    });
    expect(response.statusCode).toBe(200);
    const entitlement = (
      await ctx.app.database.db
        .select()
        .from(membershipEntitlements)
        .where(eq(membershipEntitlements.accountId, registration.accountId))
        .limit(1)
    )[0];
    expect(entitlement?.status).toBe('cancelling');
    expect(entitlement?.cancelAtPeriodEnd).toBe(true);
  });

  it('customer.subscription.updated with cancel_at_period_end=false reactivates a cancelling membership', async () => {
    const registration = await activatePasskeyAccountAndLinkCommunity({
      app: ctx.app,
      delivery: ctx.delivery,
      email: 'WebhookReactivate+setup@example.com',
    });
    const { customerId } = await seedCustomerLink(ctx, registration.accountId);
    const currentPeriodEnd = Math.floor(new Date('2030-01-01T00:00:00.000Z').getTime() / 1000);
    const subscription = primeSubscription(ctx.stripeState, {
      customerId,
      priceId: TEST_STRIPE_ANNUAL_PRICE_ID,
      currentPeriodEnd,
      status: 'active',
    });
    const invoice = primeInvoice(ctx.stripeState, {
      customerId,
      subscriptionId: subscription.id,
    });
    await postSignedWebhook(ctx, {
      eventType: 'invoice.paid',
      data: invoice as unknown as Record<string, unknown>,
    });
    await postSignedWebhook(ctx, {
      eventType: 'customer.subscription.updated',
      data: { ...(subscription as unknown as Record<string, unknown>), cancel_at_period_end: true },
    });
    const response = await postSignedWebhook(ctx, {
      eventType: 'customer.subscription.updated',
      data: {
        ...(subscription as unknown as Record<string, unknown>),
        cancel_at_period_end: false,
      },
    });
    expect(response.statusCode).toBe(200);
    const entitlement = (
      await ctx.app.database.db
        .select()
        .from(membershipEntitlements)
        .where(eq(membershipEntitlements.accountId, registration.accountId))
        .limit(1)
    )[0];
    expect(entitlement?.status).toBe('active');
    expect(entitlement?.cancelAtPeriodEnd).toBe(false);
  });

  it('customer.subscription.deleted expires the membership when access_until has already elapsed', async () => {
    const registration = await activatePasskeyAccountAndLinkCommunity({
      app: ctx.app,
      delivery: ctx.delivery,
      email: 'WebhookSubDeletedPast+setup@example.com',
    });
    const { customerId } = await seedCustomerLink(ctx, registration.accountId);
    // First, activate with a future accessUntil (activate rejects past dates).
    const futurePeriodEnd = Math.floor(new Date('2030-01-01T00:00:00.000Z').getTime() / 1000);
    const subscription = primeSubscription(ctx.stripeState, {
      customerId,
      priceId: TEST_STRIPE_ANNUAL_PRICE_ID,
      currentPeriodEnd: futurePeriodEnd,
      status: 'active',
    });
    const invoice = primeInvoice(ctx.stripeState, {
      customerId,
      subscriptionId: subscription.id,
    });
    await postSignedWebhook(ctx, {
      eventType: 'invoice.paid',
      data: invoice as unknown as Record<string, unknown>,
    });
    // Now push accessUntil into the past so subscription.deleted will expire it.
    await ctx.app.database.db
      .update(membershipEntitlements)
      .set({
        accessUntil: '2020-01-01T00:00:00.000Z',
        createdAt: '2019-12-01T00:00:00.000Z',
        updatedAt: '2019-12-30T00:00:00.000Z',
      })
      .where(eq(membershipEntitlements.accountId, registration.accountId));

    const response = await postSignedWebhook(ctx, {
      eventType: 'customer.subscription.deleted',
      data: subscription as unknown as Record<string, unknown>,
    });
    expect(response.statusCode).toBe(200);
    const entitlement = (
      await ctx.app.database.db
        .select()
        .from(membershipEntitlements)
        .where(eq(membershipEntitlements.accountId, registration.accountId))
        .limit(1)
    )[0];
    expect(entitlement?.status).toBe('expired');
  });

  it('customer.subscription.deleted preserves access when access_until is still in the future', async () => {
    const registration = await activatePasskeyAccountAndLinkCommunity({
      app: ctx.app,
      delivery: ctx.delivery,
      email: 'WebhookSubDeletedFuture+setup@example.com',
    });
    const { customerId } = await seedCustomerLink(ctx, registration.accountId);
    const currentPeriodEnd = Math.floor(new Date('2030-01-01T00:00:00.000Z').getTime() / 1000);
    const subscription = primeSubscription(ctx.stripeState, {
      customerId,
      priceId: TEST_STRIPE_ANNUAL_PRICE_ID,
      currentPeriodEnd,
      status: 'active',
    });
    const invoice = primeInvoice(ctx.stripeState, {
      customerId,
      subscriptionId: subscription.id,
    });
    await postSignedWebhook(ctx, {
      eventType: 'invoice.paid',
      data: invoice as unknown as Record<string, unknown>,
    });

    const response = await postSignedWebhook(ctx, {
      eventType: 'customer.subscription.deleted',
      data: subscription as unknown as Record<string, unknown>,
    });
    expect(response.statusCode).toBe(200);
    const entitlement = (
      await ctx.app.database.db
        .select()
        .from(membershipEntitlements)
        .where(eq(membershipEntitlements.accountId, registration.accountId))
        .limit(1)
    )[0];
    expect(entitlement?.status).toBe('active');
  });

  it('invoice.payment_failed audits only without mutating the entitlement', async () => {
    const registration = await activatePasskeyAccountAndLinkCommunity({
      app: ctx.app,
      delivery: ctx.delivery,
      email: 'WebhookPaymentFailed+setup@example.com',
    });
    const { customerId } = await seedCustomerLink(ctx, registration.accountId);
    const subscription = primeSubscription(ctx.stripeState, {
      customerId,
      priceId: TEST_STRIPE_ANNUAL_PRICE_ID,
      currentPeriodEnd: Math.floor(Date.now() / 1000) + 3600,
      status: 'active',
    });
    const invoice = primeInvoice(ctx.stripeState, {
      customerId,
      subscriptionId: subscription.id,
      status: 'open',
    });

    const response = await postSignedWebhook(ctx, {
      eventType: 'invoice.payment_failed',
      data: invoice as unknown as Record<string, unknown>,
    });
    expect(response.statusCode).toBe(200);
    const entitlement = (
      await ctx.app.database.db
        .select()
        .from(membershipEntitlements)
        .where(eq(membershipEntitlements.accountId, registration.accountId))
        .limit(1)
    )[0];
    expect(entitlement).toBeUndefined();
  });

  it('checkout.session.completed links subscription refs but does not activate the entitlement', async () => {
    const registration = await activatePasskeyAccountAndLinkCommunity({
      app: ctx.app,
      delivery: ctx.delivery,
      email: 'WebhookCheckoutCompleted+setup@example.com',
    });
    const login = await loginMobileSession({ app: ctx.app, material: registration.material });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/v1/billing/checkout-session',
      headers: { authorization: `Session ${login.sessionToken}` },
      payload: {},
    });
    expect(created.statusCode).toBe(200);
    const link = [...ctx.stripeState.customers.values()].find(
      (c) => c.metadata.town_billing_schema_version === '1',
    );
    if (!link) {
      throw new Error('expected fake Stripe customer');
    }
    const session = [...ctx.stripeState.sessions.values()][0];
    if (!session) {
      throw new Error('expected checkout session in fake Stripe state');
    }
    const subscription = primeSubscription(ctx.stripeState, {
      customerId: link.id,
      priceId: TEST_STRIPE_ANNUAL_PRICE_ID,
      currentPeriodEnd: Math.floor(new Date('2030-01-01T00:00:00.000Z').getTime() / 1000),
      status: 'active',
    });
    const completedSession: Stripe.Checkout.Session = {
      ...session,
      status: 'complete',
      payment_status: 'paid',
      subscription: subscription.id,
    };
    const response = await postSignedWebhook(ctx, {
      eventType: 'checkout.session.completed',
      data: completedSession as unknown as Record<string, unknown>,
    });
    expect(response.statusCode).toBe(200);
    const entitlement = (
      await ctx.app.database.db
        .select()
        .from(membershipEntitlements)
        .where(eq(membershipEntitlements.accountId, registration.accountId))
        .limit(1)
    )[0];
    // checkout.session.completed only links refs; entitlement is not created without a prior invoice.paid.
    expect(entitlement).toBeUndefined();
  });

  it('ignores unhandled event types with 200', async () => {
    const response = await postSignedWebhook(ctx, {
      eventType: 'ping' as unknown as Stripe.Event['type'],
      data: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });
  });
});

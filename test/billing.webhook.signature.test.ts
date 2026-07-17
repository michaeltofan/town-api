import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildSignedWebhookRequest,
  createBillingTestApp,
  signStripeWebhookHeader,
  TEST_STRIPE_WEBHOOK_SECRET,
  type BillingTestApp,
} from './helpers/billing.js';

describe('POST /v1/billing/stripe/webhook signature verification', () => {
  let ctx: BillingTestApp;

  beforeAll(async () => {
    ctx = await createBillingTestApp();
  });

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  it('rejects missing Stripe-Signature header with 400', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/billing/stripe/webhook',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ id: 'evt_missing_sig' }),
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a body signed with a different secret with 400', async () => {
    const { rawBody, signature } = buildSignedWebhookRequest({
      eventType: 'invoice.paid',
      data: { object: 'invoice' },
      secret: 'whsec_totally_different_secret_placeholder',
    });
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/billing/stripe/webhook',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': signature,
      },
      payload: rawBody,
    });
    expect(response.statusCode).toBe(400);
    void ctx.stripeState; // silence unused
  });

  it('rejects when the body is modified after signing with 400', async () => {
    const { rawBody, signature } = buildSignedWebhookRequest({
      eventType: 'invoice.paid',
      data: { object: 'invoice' },
    });
    const modified = `${rawBody.slice(0, rawBody.length - 1)}X`;
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/billing/stripe/webhook',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': signature,
      },
      payload: modified,
    });
    expect(response.statusCode).toBe(400);
  });

  it('accepts a validly signed body with 200 { received: true }', async () => {
    const rawBody = JSON.stringify({
      id: 'evt_valid_sig',
      object: 'event',
      api_version: '2026-06-24.dahlia',
      created: Math.floor(Date.now() / 1000),
      data: { object: { object: 'invoice', id: 'in_x', customer: 'cus_unresolved' } },
      livemode: false,
      pending_webhooks: 0,
      request: null,
      type: 'invoice.payment_failed',
    });
    const signature = signStripeWebhookHeader({
      payload: rawBody,
      secret: TEST_STRIPE_WEBHOOK_SECRET,
    });
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/billing/stripe/webhook',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': signature,
      },
      payload: rawBody,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });
  });

  it('returns 404 when STRIPE_BILLING_ENABLED is false', async () => {
    const disabled = await createBillingTestApp({ billingEnabled: false });
    try {
      const response = await disabled.app.inject({
        method: 'POST',
        url: '/v1/billing/stripe/webhook',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({}),
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await disabled.app.close();
      await disabled.pool.end();
    }
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activatePasskeyAccountAndLinkCommunity } from './helpers/membership.js';
import { loginMobileSession } from './helpers/passkey-management.js';
import { createBillingTestApp, type BillingTestApp } from './helpers/billing.js';

describe('POST /v1/billing/customer-portal-session', () => {
  let ctx: BillingTestApp;

  beforeAll(async () => {
    ctx = await createBillingTestApp();
  });

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  it('rejects missing session', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/billing/customer-portal-session',
      payload: {},
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'SESSION_NOT_AUTHORIZED' } });
  });

  it('returns 404 BILLING_CUSTOMER_NOT_AVAILABLE when no Stripe customer link exists', async () => {
    const registration = await activatePasskeyAccountAndLinkCommunity({
      app: ctx.app,
      delivery: ctx.delivery,
      email: 'BillingPortalUnavailable+setup@example.com',
    });
    const login = await loginMobileSession({ app: ctx.app, material: registration.material });
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/billing/customer-portal-session',
      headers: { authorization: `Session ${login.sessionToken}` },
      payload: {},
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'BILLING_CUSTOMER_NOT_AVAILABLE' } });
  });

  it('returns the Stripe portal URL when the customer link exists', async () => {
    const registration = await activatePasskeyAccountAndLinkCommunity({
      app: ctx.app,
      delivery: ctx.delivery,
      email: 'BillingPortalHappy+setup@example.com',
    });
    const login = await loginMobileSession({ app: ctx.app, material: registration.material });
    // First checkout creates the customer link.
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/v1/billing/checkout-session',
      headers: { authorization: `Session ${login.sessionToken}` },
      payload: {},
    });
    expect(created.statusCode).toBe(200);

    const portal = await ctx.app.inject({
      method: 'POST',
      url: '/v1/billing/customer-portal-session',
      headers: { authorization: `Session ${login.sessionToken}` },
      payload: {},
    });
    expect(portal.statusCode).toBe(200);
    const body = portal.json<{ data: { portalUrl: string } }>();
    expect(body.data.portalUrl).toMatch(/^https:\/\/billing\.stripe\.com\/session\/bps_/);
    expect(JSON.stringify(body)).not.toMatch(/cus_/);
  });

  it('returns 404 when STRIPE_BILLING_ENABLED is false', async () => {
    const disabledCtx = await createBillingTestApp({ billingEnabled: false });
    try {
      const response = await disabledCtx.app.inject({
        method: 'POST',
        url: '/v1/billing/customer-portal-session',
        payload: {},
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await disabledCtx.app.close();
      await disabledCtx.pool.end();
    }
  });
});

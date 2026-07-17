import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { activatePasskeyAccountAndLinkCommunity } from './helpers/membership.js';
import { createBillingTestApp, type BillingTestApp } from './helpers/billing.js';
import { ensureStripeCustomerLink } from '../src/billing/customer-service.js';
import { stripeCustomerLinks } from '../src/db/schema.js';

describe('ensureStripeCustomerLink', () => {
  let ctx: BillingTestApp;

  beforeAll(async () => {
    ctx = await createBillingTestApp();
  });

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  it('creates a Stripe customer and persists a customer link on first call', async () => {
    const registration = await activatePasskeyAccountAndLinkCommunity({
      app: ctx.app,
      delivery: ctx.delivery,
      email: 'CustomerLinkFirst+setup@example.com',
    });
    const { link, created } = await ensureStripeCustomerLink(
      ctx.app.database.db,
      ctx.stripeAdapter,
      { accountId: registration.accountId, now: new Date().toISOString() },
    );
    expect(created).toBe(true);
    expect(link.accountId).toBe(registration.accountId);
    expect(link.stripeCustomerId).toMatch(/^cus_/);
  });

  it('reuses the same link on subsequent calls (idempotent)', async () => {
    const registration = await activatePasskeyAccountAndLinkCommunity({
      app: ctx.app,
      delivery: ctx.delivery,
      email: 'CustomerLinkReuse+setup@example.com',
    });
    const first = await ensureStripeCustomerLink(ctx.app.database.db, ctx.stripeAdapter, {
      accountId: registration.accountId,
      now: new Date().toISOString(),
    });
    const second = await ensureStripeCustomerLink(ctx.app.database.db, ctx.stripeAdapter, {
      accountId: registration.accountId,
      now: new Date().toISOString(),
    });
    expect(second.created).toBe(false);
    expect(second.link.id).toBe(first.link.id);
    expect(second.link.stripeCustomerId).toBe(first.link.stripeCustomerId);
    const rows = await ctx.app.database.db
      .select()
      .from(stripeCustomerLinks)
      .where(eq(stripeCustomerLinks.accountId, registration.accountId));
    expect(rows).toHaveLength(1);
  });

  it('concurrent ensureStripeCustomerLink calls resolve to exactly one row', async () => {
    const registration = await activatePasskeyAccountAndLinkCommunity({
      app: ctx.app,
      delivery: ctx.delivery,
      email: 'CustomerLinkConcurrent+setup@example.com',
    });
    const nowIso = new Date().toISOString();
    const results = await Promise.all([
      ensureStripeCustomerLink(ctx.app.database.db, ctx.stripeAdapter, {
        accountId: registration.accountId,
        now: nowIso,
      }),
      ensureStripeCustomerLink(ctx.app.database.db, ctx.stripeAdapter, {
        accountId: registration.accountId,
        now: nowIso,
      }),
      ensureStripeCustomerLink(ctx.app.database.db, ctx.stripeAdapter, {
        accountId: registration.accountId,
        now: nowIso,
      }),
    ]);
    const rows = await ctx.app.database.db
      .select()
      .from(stripeCustomerLinks)
      .where(eq(stripeCustomerLinks.accountId, registration.accountId));
    expect(rows).toHaveLength(1);
    for (const result of results) {
      expect(result.link.accountId).toBe(registration.accountId);
      expect(result.link.stripeCustomerId).toBe(rows[0]?.stripeCustomerId);
    }
  });
});

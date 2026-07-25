import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { membershipEntitlements } from '../src/db/schema.js';
import { activatePasskeyAccountAndLinkCommunity } from './helpers/membership.js';
import {
  createGooglePlayTestApp,
  seedActiveGooglePlayPurchase,
  TEST_GOOGLE_PLAY_PACKAGE_NAME,
  TEST_GOOGLE_PLAY_SUBSCRIPTION_ID,
  type GooglePlayTestApp,
} from './helpers/google-play.js';
import { loginMobileSession } from './helpers/passkey-management.js';

const FIXED_NOW = '2026-07-25T16:30:00.000Z';
const ACCESS_UNTIL = '2027-07-25T16:30:00.000Z';

describe('eligibility bind finalises paid_pending_binding (S5 API)', () => {
  let ctx: GooglePlayTestApp;
  let clock: { now: string };

  beforeAll(async () => {
    clock = { now: FIXED_NOW };
    ctx = await createGooglePlayTestApp({
      now: () => clock.now,
      envOverrides: {
        LOCAL_ELIGIBILITY_ENABLED: 'true',
      },
    });
  });

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  it('purchase ingress stays paid_pending_binding; eligibility bind finalises to active', async () => {
    const registration = await activatePasskeyAccountAndLinkCommunity({
      app: ctx.app,
      delivery: ctx.delivery,
      email: 'finalize.eligibility@example.com',
      linkCommunity: false,
    });
    const login = await loginMobileSession({
      app: ctx.app,
      material: registration.material,
      userHandle: registration.userHandle,
    });

    const purchaseToken = 'gp_token_finalize_via_eligibility';
    seedActiveGooglePlayPurchase(ctx.googlePlayState, {
      purchaseToken,
      expiryTime: ACCESS_UNTIL,
    });

    const purchase = await ctx.app.inject({
      method: 'POST',
      url: '/v1/billing/google-play/purchases',
      headers: { authorization: `Session ${login.sessionToken}` },
      payload: {
        purchaseToken,
        packageName: TEST_GOOGLE_PLAY_PACKAGE_NAME,
        subscriptionId: TEST_GOOGLE_PLAY_SUBSCRIPTION_ID,
      },
    });
    expect(purchase.statusCode).toBe(200);
    expect(purchase.json()).toMatchObject({
      data: {
        result: 'applied',
        membership: { status: 'paid_pending_binding' },
      },
    });

    const before = await ctx.app.database.db
      .select()
      .from(membershipEntitlements)
      .where(eq(membershipEntitlements.accountId, registration.accountId))
      .limit(1);
    expect(before[0]?.status).toBe('paid_pending_binding');
    expect(before[0]?.activatedAt).toBeNull();

    const eligibility = await ctx.app.inject({
      method: 'PUT',
      url: '/v1/account/eligibility',
      headers: { authorization: `Session ${login.sessionToken}` },
      payload: { community: 'milano-it' },
    });
    expect(eligibility.statusCode).toBe(200);
    expect(eligibility.json()).toMatchObject({
      data: { localEligibility: 'eligible', community: { slug: 'milano-it' } },
    });

    const after = await ctx.app.database.db
      .select()
      .from(membershipEntitlements)
      .where(eq(membershipEntitlements.accountId, registration.accountId))
      .limit(1);
    expect(after[0]?.status).toBe('active');
    expect(after[0]?.activatedAt).not.toBeNull();
    expect(Number(after[0]?.version)).toBe(2);

    const membership = await ctx.app.inject({
      method: 'GET',
      url: '/v1/account/membership',
      headers: { authorization: `Session ${login.sessionToken}` },
    });
    expect(membership.statusCode).toBe(200);
    expect(membership.json()).toMatchObject({
      data: {
        membership: { status: 'active' },
      },
    });
  });

  it('eligibility bind without paid_pending_binding entitlement still succeeds', async () => {
    const registration = await activatePasskeyAccountAndLinkCommunity({
      app: ctx.app,
      delivery: ctx.delivery,
      email: 'finalize.eligibility.noentitlement@example.com',
      linkCommunity: false,
    });
    const login = await loginMobileSession({
      app: ctx.app,
      material: registration.material,
      userHandle: registration.userHandle,
    });

    const eligibility = await ctx.app.inject({
      method: 'PUT',
      url: '/v1/account/eligibility',
      headers: { authorization: `Session ${login.sessionToken}` },
      payload: { community: 'munich-de' },
    });
    expect(eligibility.statusCode).toBe(200);
    expect(eligibility.json()).toMatchObject({
      data: { localEligibility: 'eligible', community: { slug: 'munich-de' } },
    });
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  activateTestMembership,
  activatePasskeyAccountAndLinkCommunity,
  createEligibleTestResolver,
  createMembershipTestApp,
  expireTestMembership,
  reactivateTestMembership,
  scheduleTestCancellation,
} from './helpers/membership.js';
import { loginMobileSession } from './helpers/passkey-management.js';

describe('GET /v1/account/membership', () => {
  let ctx: Awaited<ReturnType<typeof createMembershipTestApp>>;

  beforeAll(async () => {
    ctx = await createMembershipTestApp({
      localEligibilityResolver: createEligibleTestResolver(),
    });
  });

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  it('rejects missing session with SESSION_NOT_AUTHORIZED', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/v1/account/membership',
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'SESSION_NOT_AUTHORIZED' } });
  });

  it('rejects SetupGrant, RecoveryGrant, and Bearer schemes', async () => {
    for (const scheme of ['SetupGrant', 'RecoveryGrant', 'Bearer'] as const) {
      const response = await ctx.app.inject({
        method: 'GET',
        url: '/v1/account/membership',
        headers: { authorization: `${scheme} not-a-real-token` },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: 'SESSION_NOT_AUTHORIZED' } });
    }
  });

  it('rejects an unknown mobile session token', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/v1/account/membership',
      headers: { authorization: 'Session bogus-token' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'SESSION_NOT_AUTHORIZED' } });
  });

  it('returns inactive/visitor-level access when the account has no entitlement', async () => {
    const registration = await activatePasskeyAccountAndLinkCommunity({
      app: ctx.app,
      delivery: ctx.delivery,
      email: 'MembershipInactive+setup@example.com',
    });
    const login = await loginMobileSession({ app: ctx.app, material: registration.material });
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/v1/account/membership',
      headers: { authorization: `Session ${login.sessionToken}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      data: {
        membership: { status: string; accessUntil: null | string; cancelAtPeriodEnd: boolean };
        access: { level: string; canParticipate: boolean; localEligibility: string };
      };
    }>();
    expect(body.data.membership).toEqual({
      status: 'inactive',
      accessUntil: null,
      cancelAtPeriodEnd: false,
    });
    expect(body.data.access.level).toBe('read_only');
    expect(body.data.access.canParticipate).toBe(false);
    // No Stripe identifiers surface in the response.
    expect(JSON.stringify(body)).not.toMatch(/cus_|sub_|sourceCustomerId|sourceSubscriptionId/);
  });

  it('returns active + participant when membership is active and local eligibility is granted', async () => {
    const registration = await activatePasskeyAccountAndLinkCommunity({
      app: ctx.app,
      delivery: ctx.delivery,
      email: 'MembershipActive+setup@example.com',
    });
    await activateTestMembership(ctx.app, {
      accountId: registration.accountId,
      effectiveAt: '2026-07-17T12:00:00.000Z',
      accessUntil: '2030-01-01T00:00:00.000Z',
    });
    const login = await loginMobileSession({ app: ctx.app, material: registration.material });
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/v1/account/membership',
      headers: { authorization: `Session ${login.sessionToken}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      data: {
        membership: { status: string; accessUntil: string; cancelAtPeriodEnd: boolean };
        access: { level: string; canParticipate: boolean; localEligibility: string };
      };
    }>();
    expect(body.data.membership.status).toBe('active');
    expect(body.data.membership.accessUntil).toBe('2030-01-01T00:00:00.000Z');
    expect(body.data.membership.cancelAtPeriodEnd).toBe(false);
    expect(body.data.access.level).toBe('participant');
    expect(body.data.access.canParticipate).toBe(true);
    expect(body.data.access.localEligibility).toBe('eligible');
  });

  it('reports cancelling status when scheduled cancellation is pending', async () => {
    const registration = await activatePasskeyAccountAndLinkCommunity({
      app: ctx.app,
      delivery: ctx.delivery,
      email: 'MembershipCancelling+setup@example.com',
    });
    await activateTestMembership(ctx.app, {
      accountId: registration.accountId,
      effectiveAt: '2026-07-17T12:00:00.000Z',
      accessUntil: '2030-01-01T00:00:00.000Z',
    });
    await scheduleTestCancellation(ctx.app, {
      accountId: registration.accountId,
      effectiveAt: '2026-07-18T12:00:00.000Z',
    });
    const login = await loginMobileSession({ app: ctx.app, material: registration.material });
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/v1/account/membership',
      headers: { authorization: `Session ${login.sessionToken}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      data: {
        membership: { status: string; accessUntil: string; cancelAtPeriodEnd: boolean };
        access: { level: string; canParticipate: boolean };
      };
    }>();
    expect(body.data.membership.status).toBe('cancelling');
    expect(body.data.membership.cancelAtPeriodEnd).toBe(true);
    expect(body.data.access.canParticipate).toBe(true);
    expect(body.data.access.level).toBe('participant');

    // Reactivating removes cancel_at_period_end and stays active.
    await reactivateTestMembership(ctx.app, {
      accountId: registration.accountId,
      effectiveAt: '2026-07-19T12:00:00.000Z',
    });
    const reactivated = await ctx.app.inject({
      method: 'GET',
      url: '/v1/account/membership',
      headers: { authorization: `Session ${login.sessionToken}` },
    });
    const reactivatedBody = reactivated.json<{
      data: {
        membership: { status: string; cancelAtPeriodEnd: boolean };
      };
    }>();
    expect(reactivatedBody.data.membership.status).toBe('active');
    expect(reactivatedBody.data.membership.cancelAtPeriodEnd).toBe(false);
  });

  it('reports expired status after an expire transition', async () => {
    const registration = await activatePasskeyAccountAndLinkCommunity({
      app: ctx.app,
      delivery: ctx.delivery,
      email: 'MembershipExpired+setup@example.com',
    });
    await activateTestMembership(ctx.app, {
      accountId: registration.accountId,
      effectiveAt: '2026-07-17T12:00:00.000Z',
      accessUntil: '2026-08-17T00:00:00.000Z',
    });
    await expireTestMembership(ctx.app, {
      accountId: registration.accountId,
      effectiveAt: '2026-08-17T00:00:00.000Z',
    });
    const login = await loginMobileSession({ app: ctx.app, material: registration.material });
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/v1/account/membership',
      headers: { authorization: `Session ${login.sessionToken}` },
    });
    const body = response.json<{
      data: {
        membership: { status: string; accessUntil: string; cancelAtPeriodEnd: boolean };
        access: { level: string; canParticipate: boolean };
      };
    }>();
    expect(body.data.membership.status).toBe('expired');
    expect(body.data.membership.cancelAtPeriodEnd).toBe(false);
    expect(body.data.access.level).toBe('read_only');
    expect(body.data.access.canParticipate).toBe(false);
  });

  it('reports expired stale-temporal boundary: now >= access_until without an explicit expire event', async () => {
    // Create a fresh test app with fixed now so we can activate with access_until then set now to that.
    const fixedNow = { current: '2026-07-17T12:00:00.000Z' };
    const staleCtx = await createMembershipTestApp({
      now: () => fixedNow.current,
      localEligibilityResolver: createEligibleTestResolver(),
    });
    try {
      const registration = await activatePasskeyAccountAndLinkCommunity({
        app: staleCtx.app,
        delivery: staleCtx.delivery,
        email: 'MembershipStaleTemporal+setup@example.com',
      });
      await activateTestMembership(staleCtx.app, {
        accountId: registration.accountId,
        effectiveAt: '2026-07-17T12:00:00.000Z',
        accessUntil: '2026-07-17T12:20:00.000Z',
      });
      const login = await loginMobileSession({
        app: staleCtx.app,
        material: registration.material,
      });
      // Advance time past access_until but keep the session within its idle window.
      fixedNow.current = '2026-07-17T12:30:00.000Z';
      const response = await staleCtx.app.inject({
        method: 'GET',
        url: '/v1/account/membership',
        headers: { authorization: `Session ${login.sessionToken}` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<{
        data: {
          membership: { status: string; cancelAtPeriodEnd: boolean };
          access: { level: string };
        };
      }>();
      expect(body.data.membership.status).toBe('expired');
      expect(body.data.membership.cancelAtPeriodEnd).toBe(false);
      expect(body.data.access.level).toBe('read_only');
    } finally {
      await staleCtx.app.close();
      await staleCtx.pool.end();
    }
  });
});

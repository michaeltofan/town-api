import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import {
  accountSessions,
  accounts,
  identitySecurityEvents,
  membershipEntitlements,
  platformAuditEvents,
  platformOperators,
  signals,
} from '../src/db/schema.js';
import {
  FOUNDATION_COMMUNITY_IDS,
  FOUNDATION_SIGNAL_IDS,
} from '../src/db/seeds/foundation-content.js';
import { activateMembership } from '../src/membership/transitions/activate.js';
import type {
  PlatformAccountActionResponse,
  PlatformAccountsResponse,
  PlatformMembershipActionResponse,
  PlatformMembershipsResponse,
  PlatformSessionResponse,
  PlatformStatusResponse,
} from '../src/schemas/platform.js';
import {
  activatePasskeyAccountAndLinkCommunity,
  activateTestMembership,
  createEligibleTestResolver,
  createMembershipTestApp,
} from './helpers/membership.js';
import { loginMobileSession } from './helpers/passkey-management.js';
import type { SoftPasskeyMaterial } from './helpers/webauthn-soft-authenticator.js';

const FIXED_NOW = '2026-08-01T12:00:00.000Z';
const ACCESS_UNTIL = '2030-01-01T00:00:00.000Z';
const EXTENDED_UNTIL = '2031-01-01T00:00:00.000Z';

describe('platform operator area', () => {
  let ctx: Awaited<ReturnType<typeof createMembershipTestApp>>;
  let clock: { now: string };
  let clientKeySeq = 0;

  beforeAll(async () => {
    clock = { now: FIXED_NOW };
    ctx = await createMembershipTestApp({
      now: () => clock.now,
      localEligibilityResolver: createEligibleTestResolver(),
    });
  });

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  function nextAnonymousClientKey(): string {
    clientKeySeq += 1;
    return `anonymous-client-key-platform-${String(clientKeySeq).padStart(4, '0')}`;
  }

  async function registerMember(email: string): Promise<{
    accountId: string;
    sessionToken: string;
    material: SoftPasskeyMaterial;
  }> {
    clock.now = new Date(new Date(clock.now).getTime() + 16 * 60_000).toISOString();
    const registration = await activatePasskeyAccountAndLinkCommunity({
      app: ctx.app,
      delivery: ctx.delivery,
      email,
      communityId: FOUNDATION_COMMUNITY_IDS.milanoIt,
    });
    await activateTestMembership(ctx.app, {
      accountId: registration.accountId,
      effectiveAt: clock.now,
      accessUntil: ACCESS_UNTIL,
      now: clock.now,
    });
    const login = await loginMobileSession({
      app: ctx.app,
      material: registration.material,
      anonymousClientKey: nextAnonymousClientKey(),
    });
    return {
      accountId: registration.accountId,
      sessionToken: login.sessionToken,
      material: registration.material,
    };
  }

  async function grantOperator(
    accountId: string,
    role:
      | 'viewer'
      | 'investigator'
      | 'moderator'
      | 'account_admin'
      | 'ops_admin'
      | 'role_admin' = 'ops_admin',
  ): Promise<void> {
    await ctx.app.database.db.insert(platformOperators).values({
      accountId,
      role,
      grantedAt: clock.now,
      grantedByAccountId: null,
      revokedAt: null,
      updatedAt: clock.now,
    });
  }

  it('hides platform surfaces from non-operators with 404', async () => {
    const member = await registerMember('PlatformNonOperator+setup@example.com');
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/v1/platform/session',
      headers: { authorization: `Session ${member.sessionToken}` },
    });
    expect(response.statusCode).toBe(404);
  });

  it('returns operator session and status for an active platform operator', async () => {
    const operator = await registerMember('PlatformOperatorSession+setup@example.com');
    await grantOperator(operator.accountId, 'ops_admin');

    const session = await ctx.app.inject({
      method: 'GET',
      url: '/v1/platform/session',
      headers: { authorization: `Session ${operator.sessionToken}` },
    });
    expect(session.statusCode).toBe(200);
    expect(session.json<PlatformSessionResponse>()).toMatchObject({
      data: { accountId: operator.accountId, role: 'ops_admin' },
    });

    const status = await ctx.app.inject({
      method: 'GET',
      url: '/v1/platform/status',
      headers: { authorization: `Session ${operator.sessionToken}` },
    });
    expect(status.statusCode).toBe(200);
    const body = status.json<PlatformStatusResponse>();
    expect(body.data.health.live).toBe('ok');
    expect(body.data.counts.accounts.total).toBeGreaterThan(0);

    const audits = await ctx.app.database.db
      .select()
      .from(platformAuditEvents)
      .where(eq(platformAuditEvents.action, 'status_viewed'));
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  it('lists accounts and suspends / reactivates with platform + identity audit', async () => {
    const operator = await registerMember('PlatformOperatorAccounts+setup@example.com');
    await grantOperator(operator.accountId, 'account_admin');
    const member = await registerMember('PlatformMemberToSuspend+setup@example.com');

    const list = await ctx.app.inject({
      method: 'GET',
      url: '/v1/platform/accounts?limit=50',
      headers: { authorization: `Session ${operator.sessionToken}` },
    });
    expect(list.statusCode).toBe(200);
    const listed = list.json<PlatformAccountsResponse>().data.accounts;
    expect(listed.some((row) => row.accountId === member.accountId)).toBe(true);

    const suspend = await ctx.app.inject({
      method: 'POST',
      url: `/v1/platform/accounts/${member.accountId}/suspend`,
      headers: { authorization: `Session ${operator.sessionToken}` },
      payload: { reason: 'spam' },
    });
    expect(suspend.statusCode).toBe(200);
    expect(suspend.json<PlatformAccountActionResponse>()).toMatchObject({
      data: { accountId: member.accountId, status: 'suspended', changed: true },
    });

    const row = await ctx.app.database.db
      .select()
      .from(accounts)
      .where(eq(accounts.id, member.accountId))
      .then((rows) => rows[0]);
    expect(row?.status).toBe('suspended');

    const activeSessions = await ctx.app.database.db
      .select()
      .from(accountSessions)
      .where(
        and(eq(accountSessions.accountId, member.accountId), isNull(accountSessions.revokedAt)),
      );
    expect(activeSessions).toHaveLength(0);

    const identityAudit = await ctx.app.database.db
      .select()
      .from(identitySecurityEvents)
      .where(eq(identitySecurityEvents.eventType, 'account_suspended'));
    expect(
      identityAudit.some(
        (event) =>
          event.accountId === operator.accountId &&
          (event.metadata as { targetAccountId?: string } | null)?.targetAccountId ===
            member.accountId,
      ),
    ).toBe(true);

    const reactivate = await ctx.app.inject({
      method: 'POST',
      url: `/v1/platform/accounts/${member.accountId}/reactivate`,
      headers: { authorization: `Session ${operator.sessionToken}` },
    });
    expect(reactivate.statusCode).toBe(200);
    expect(reactivate.json<PlatformAccountActionResponse>().data).toMatchObject({
      status: 'active',
      changed: true,
    });
  });

  it('hides and unhides signals for moderators', async () => {
    const operator = await registerMember('PlatformOperatorModeration+setup@example.com');
    await grantOperator(operator.accountId, 'moderator');
    const signalId = FOUNDATION_SIGNAL_IDS.milanoSignal1;

    const hide = await ctx.app.inject({
      method: 'POST',
      url: `/v1/platform/signals/${signalId}/hide`,
      headers: { authorization: `Session ${operator.sessionToken}` },
      payload: { reason: 'off_topic' },
    });
    expect(hide.statusCode).toBe(200);
    expect(hide.json()).toMatchObject({
      data: { signalId, hidden: true, changed: true },
    });

    const hiddenRow = await ctx.app.database.db
      .select()
      .from(signals)
      .where(eq(signals.id, signalId))
      .then((rows) => rows[0]);
    expect(hiddenRow?.hiddenAt).not.toBeNull();

    const unhide = await ctx.app.inject({
      method: 'POST',
      url: `/v1/platform/signals/${signalId}/unhide`,
      headers: { authorization: `Session ${operator.sessionToken}` },
    });
    expect(unhide.statusCode).toBe(200);
    expect(unhide.json()).toMatchObject({
      data: { signalId, hidden: false, changed: true },
    });
  });

  it('allows role_admin to grant and revoke operators', async () => {
    const admin = await registerMember('PlatformRoleAdmin+setup@example.com');
    await grantOperator(admin.accountId, 'role_admin');
    const target = await registerMember('PlatformNewOperator+setup@example.com');

    const grant = await ctx.app.inject({
      method: 'POST',
      url: '/v1/platform/operators',
      headers: { authorization: `Session ${admin.sessionToken}` },
      payload: { accountId: target.accountId, role: 'viewer' },
    });
    expect(grant.statusCode).toBe(200);
    expect(grant.json()).toMatchObject({
      data: { accountId: target.accountId, role: 'viewer', active: true, changed: true },
    });

    const list = await ctx.app.inject({
      method: 'GET',
      url: '/v1/platform/operators',
      headers: { authorization: `Session ${admin.sessionToken}` },
    });
    expect(list.statusCode).toBe(200);
    const operatorsBody = list.json<{
      data: { operators: { accountId: string }[] };
    }>();
    expect(operatorsBody.data.operators.some((row) => row.accountId === target.accountId)).toBe(
      true,
    );

    const revoke = await ctx.app.inject({
      method: 'POST',
      url: `/v1/platform/operators/${target.accountId}/revoke`,
      headers: { authorization: `Session ${admin.sessionToken}` },
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json()).toMatchObject({
      data: { accountId: target.accountId, active: false, changed: true },
    });
  });

  it('denies account suspend for viewer role', async () => {
    const viewer = await registerMember('PlatformViewerOnly+setup@example.com');
    await grantOperator(viewer.accountId, 'viewer');
    const member = await registerMember('PlatformViewerTarget+setup@example.com');

    const suspend = await ctx.app.inject({
      method: 'POST',
      url: `/v1/platform/accounts/${member.accountId}/suspend`,
      headers: { authorization: `Session ${viewer.sessionToken}` },
      payload: { reason: 'spam' },
    });
    expect(suspend.statusCode).toBe(404);
  });

  async function registerAccountWithoutMembership(email: string): Promise<{
    accountId: string;
    sessionToken: string;
  }> {
    clock.now = new Date(new Date(clock.now).getTime() + 16 * 60_000).toISOString();
    const registration = await activatePasskeyAccountAndLinkCommunity({
      app: ctx.app,
      delivery: ctx.delivery,
      email,
      communityId: FOUNDATION_COMMUNITY_IDS.milanoIt,
    });
    const login = await loginMobileSession({
      app: ctx.app,
      material: registration.material,
      anonymousClientKey: nextAnonymousClientKey(),
    });
    return { accountId: registration.accountId, sessionToken: login.sessionToken };
  }

  it('role_admin can grant, extend, and schedule-cancel admin memberships with audit', async () => {
    const operator = await registerMember('PlatformMembershipOpsAdmin+setup@example.com');
    await grantOperator(operator.accountId, 'role_admin');
    const target = await registerAccountWithoutMembership(
      'PlatformMembershipGrantTarget+setup@example.com',
    );
    const grantKey = randomUUID();

    const grant = await ctx.app.inject({
      method: 'POST',
      url: '/v1/platform/memberships/grant',
      headers: { authorization: `Session ${operator.sessionToken}` },
      payload: {
        accountId: target.accountId,
        accessUntil: ACCESS_UNTIL,
        reason: 'Comped civic access for verified partner',
        idempotencyKey: grantKey,
      },
    });
    expect(grant.statusCode).toBe(200);
    expect(grant.json<PlatformMembershipActionResponse>()).toMatchObject({
      data: {
        accountId: target.accountId,
        status: 'active',
        source: 'admin',
        accessUntil: ACCESS_UNTIL,
        changed: true,
        allowedActions: ['extend', 'schedule_cancellation'],
      },
    });

    const list = await ctx.app.inject({
      method: 'GET',
      url: `/v1/platform/memberships?q=${encodeURIComponent(target.accountId)}`,
      headers: { authorization: `Session ${operator.sessionToken}` },
    });
    expect(list.statusCode).toBe(200);
    const listed = list.json<PlatformMembershipsResponse>().data.memberships;
    expect(listed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accountId: target.accountId,
          source: 'admin',
          status: 'active',
          accessUntil: ACCESS_UNTIL,
          allowedActions: ['extend', 'schedule_cancellation'],
        }),
      ]),
    );

    const grantReplay = await ctx.app.inject({
      method: 'POST',
      url: '/v1/platform/memberships/grant',
      headers: { authorization: `Session ${operator.sessionToken}` },
      payload: {
        accountId: target.accountId,
        accessUntil: ACCESS_UNTIL,
        reason: 'Comped civic access for verified partner',
        idempotencyKey: grantKey,
      },
    });
    expect(grantReplay.statusCode).toBe(200);
    expect(grantReplay.json<PlatformMembershipActionResponse>().data.changed).toBe(false);

    const grantAudits = await ctx.app.database.db
      .select()
      .from(platformAuditEvents)
      .where(
        and(
          eq(platformAuditEvents.action, 'membership_granted'),
          eq(platformAuditEvents.targetAccountId, target.accountId),
        ),
      );
    expect(grantAudits).toHaveLength(1);
    expect(grantAudits[0]?.operatorAccountId).toBe(operator.accountId);
    expect(grantAudits[0]?.metadata).toMatchObject({
      reason: 'Comped civic access for verified partner',
    });

    const extendKey = randomUUID();
    const extend = await ctx.app.inject({
      method: 'POST',
      url: `/v1/platform/memberships/${target.accountId}/extend`,
      headers: { authorization: `Session ${operator.sessionToken}` },
      payload: {
        accessUntil: EXTENDED_UNTIL,
        reason: 'Extend partner access through next cycle',
        idempotencyKey: extendKey,
      },
    });
    expect(extend.statusCode).toBe(200);
    expect(extend.json<PlatformMembershipActionResponse>()).toMatchObject({
      data: {
        accountId: target.accountId,
        status: 'active',
        source: 'admin',
        accessUntil: EXTENDED_UNTIL,
        changed: true,
      },
    });

    const extendReplay = await ctx.app.inject({
      method: 'POST',
      url: `/v1/platform/memberships/${target.accountId}/extend`,
      headers: { authorization: `Session ${operator.sessionToken}` },
      payload: {
        accessUntil: EXTENDED_UNTIL,
        reason: 'Extend partner access through next cycle',
        idempotencyKey: extendKey,
      },
    });
    expect(extendReplay.statusCode).toBe(200);
    expect(extendReplay.json<PlatformMembershipActionResponse>().data.changed).toBe(false);

    const cancelKey = randomUUID();
    const cancel = await ctx.app.inject({
      method: 'POST',
      url: `/v1/platform/memberships/${target.accountId}/schedule-cancellation`,
      headers: { authorization: `Session ${operator.sessionToken}` },
      payload: {
        reason: 'Partner engagement completed',
        idempotencyKey: cancelKey,
      },
    });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json<PlatformMembershipActionResponse>()).toMatchObject({
      data: {
        accountId: target.accountId,
        status: 'cancelling',
        source: 'admin',
        cancelAtPeriodEnd: true,
        changed: true,
        allowedActions: [],
      },
    });

    const cancelReplay = await ctx.app.inject({
      method: 'POST',
      url: `/v1/platform/memberships/${target.accountId}/schedule-cancellation`,
      headers: { authorization: `Session ${operator.sessionToken}` },
      payload: {
        reason: 'Partner engagement completed',
        idempotencyKey: cancelKey,
      },
    });
    expect(cancelReplay.statusCode).toBe(200);
    expect(cancelReplay.json<PlatformMembershipActionResponse>().data.changed).toBe(false);

    const refreshed = await ctx.app.inject({
      method: 'GET',
      url: `/v1/platform/memberships?q=${encodeURIComponent(target.accountId)}`,
      headers: { authorization: `Session ${operator.sessionToken}` },
    });
    expect(refreshed.json<PlatformMembershipsResponse>().data.memberships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accountId: target.accountId,
          status: 'cancelling',
          source: 'admin',
          accessUntil: EXTENDED_UNTIL,
          cancelAtPeriodEnd: true,
          allowedActions: [],
        }),
      ]),
    );

    const cancelAudits = await ctx.app.database.db
      .select()
      .from(platformAuditEvents)
      .where(
        and(
          eq(platformAuditEvents.action, 'membership_cancellation_scheduled'),
          eq(platformAuditEvents.targetAccountId, target.accountId),
        ),
      );
    expect(cancelAudits).toHaveLength(1);
  });

  it('refuses ordinary users and insufficient roles for membership mutations', async () => {
    const member = await registerAccountWithoutMembership(
      'PlatformMembershipOrdinary+setup@example.com',
    );
    const viewer = await registerMember('PlatformMembershipViewer+setup@example.com');
    await grantOperator(viewer.accountId, 'viewer');
    const accountAdmin = await registerMember('PlatformMembershipAccountAdmin+setup@example.com');
    await grantOperator(accountAdmin.accountId, 'account_admin');
    const target = await registerAccountWithoutMembership(
      'PlatformMembershipDeniedTarget+setup@example.com',
    );

    const ordinary = await ctx.app.inject({
      method: 'POST',
      url: '/v1/platform/memberships/grant',
      headers: { authorization: `Session ${member.sessionToken}` },
      payload: {
        accountId: target.accountId,
        accessUntil: ACCESS_UNTIL,
        reason: 'Should be hidden',
        idempotencyKey: randomUUID(),
      },
    });
    expect(ordinary.statusCode).toBe(404);

    const viewerDenied = await ctx.app.inject({
      method: 'POST',
      url: '/v1/platform/memberships/grant',
      headers: { authorization: `Session ${viewer.sessionToken}` },
      payload: {
        accountId: target.accountId,
        accessUntil: ACCESS_UNTIL,
        reason: 'Viewer cannot grant',
        idempotencyKey: randomUUID(),
      },
    });
    expect(viewerDenied.statusCode).toBe(404);

    const accountAdminDenied = await ctx.app.inject({
      method: 'POST',
      url: `/v1/platform/memberships/${target.accountId}/extend`,
      headers: { authorization: `Session ${accountAdmin.sessionToken}` },
      payload: {
        accessUntil: EXTENDED_UNTIL,
        reason: 'Account admin cannot extend',
        idempotencyKey: randomUUID(),
      },
    });
    expect(accountAdminDenied.statusCode).toBe(404);
  });

  it('rejects invalid transitions and provider-managed Stripe membership mutations', async () => {
    const operator = await registerMember('PlatformMembershipStripeOps+setup@example.com');
    await grantOperator(operator.accountId, 'ops_admin');
    const target = await registerAccountWithoutMembership(
      'PlatformMembershipStripeTarget+setup@example.com',
    );

    await activateMembership(
      ctx.app.database.db,
      {
        source: 'stripe',
        sourceEventId: `stripe:test:activate:${randomUUID()}`,
        eventType: 'activate',
        accountId: target.accountId,
        effectiveAt: clock.now,
        accessUntil: ACCESS_UNTIL,
        sourceCustomerId: 'cus_test_platform',
        sourceSubscriptionId: `sub_test_platform_${randomUUID()}`,
      },
      { processedAt: clock.now, nodeEnv: 'test' },
    );

    const grantOverStripe = await ctx.app.inject({
      method: 'POST',
      url: '/v1/platform/memberships/grant',
      headers: { authorization: `Session ${operator.sessionToken}` },
      payload: {
        accountId: target.accountId,
        accessUntil: EXTENDED_UNTIL,
        reason: 'Must not overwrite Stripe',
        idempotencyKey: randomUUID(),
      },
    });
    expect(grantOverStripe.statusCode).toBe(409);
    expect(grantOverStripe.json()).toMatchObject({
      error: { code: 'PROVIDER_MANAGED_MEMBERSHIP' },
    });

    const extendStripe = await ctx.app.inject({
      method: 'POST',
      url: `/v1/platform/memberships/${target.accountId}/extend`,
      headers: { authorization: `Session ${operator.sessionToken}` },
      payload: {
        accessUntil: EXTENDED_UNTIL,
        reason: 'Must not extend Stripe locally',
        idempotencyKey: randomUUID(),
      },
    });
    expect(extendStripe.statusCode).toBe(409);
    expect(extendStripe.json()).toMatchObject({
      error: { code: 'PROVIDER_MANAGED_MEMBERSHIP' },
    });

    const cancelStripe = await ctx.app.inject({
      method: 'POST',
      url: `/v1/platform/memberships/${target.accountId}/schedule-cancellation`,
      headers: { authorization: `Session ${operator.sessionToken}` },
      payload: {
        reason: 'Must not cancel Stripe locally',
        idempotencyKey: randomUUID(),
      },
    });
    expect(cancelStripe.statusCode).toBe(409);
    expect(cancelStripe.json()).toMatchObject({
      error: { code: 'PROVIDER_MANAGED_MEMBERSHIP' },
    });

    const stripeRow = await ctx.app.database.db
      .select()
      .from(membershipEntitlements)
      .where(eq(membershipEntitlements.accountId, target.accountId))
      .limit(1);
    expect(stripeRow[0]?.source).toBe('stripe');
    expect(stripeRow[0]?.status).toBe('active');
    expect(new Date(stripeRow[0]?.accessUntil ?? '').getTime()).toBe(
      new Date(ACCESS_UNTIL).getTime(),
    );

    const adminTarget = await registerAccountWithoutMembership(
      'PlatformMembershipInvalidExtend+setup@example.com',
    );
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/platform/memberships/grant',
      headers: { authorization: `Session ${operator.sessionToken}` },
      payload: {
        accountId: adminTarget.accountId,
        accessUntil: ACCESS_UNTIL,
        reason: 'Baseline admin grant',
        idempotencyKey: randomUUID(),
      },
    });

    const invalidExtend = await ctx.app.inject({
      method: 'POST',
      url: `/v1/platform/memberships/${adminTarget.accountId}/extend`,
      headers: { authorization: `Session ${operator.sessionToken}` },
      payload: {
        accessUntil: ACCESS_UNTIL,
        reason: 'Not strictly later',
        idempotencyKey: randomUUID(),
      },
    });
    expect(invalidExtend.statusCode).toBe(409);
    expect(invalidExtend.json()).toMatchObject({
      error: { code: 'MEMBERSHIP_OPERATION_NOT_ALLOWED' },
    });
  });

  it('keeps existing console inventory surfaces working after membership ops', async () => {
    const operator = await registerMember('PlatformMembershipRegression+setup@example.com');
    await grantOperator(operator.accountId, 'ops_admin');

    const status = await ctx.app.inject({
      method: 'GET',
      url: '/v1/platform/status',
      headers: { authorization: `Session ${operator.sessionToken}` },
    });
    expect(status.statusCode).toBe(200);

    const accountsList = await ctx.app.inject({
      method: 'GET',
      url: '/v1/platform/accounts?limit=10',
      headers: { authorization: `Session ${operator.sessionToken}` },
    });
    expect(accountsList.statusCode).toBe(200);
    expect(accountsList.json<PlatformAccountsResponse>().data.accounts.length).toBeGreaterThan(0);

    const memberships = await ctx.app.inject({
      method: 'GET',
      url: '/v1/platform/memberships?limit=10',
      headers: { authorization: `Session ${operator.sessionToken}` },
    });
    expect(memberships.statusCode).toBe(200);
    expect(memberships.json<PlatformMembershipsResponse>().data.memberships.length).toBeGreaterThan(
      0,
    );
  });
});

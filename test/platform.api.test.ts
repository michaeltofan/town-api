import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import {
  accountSessions,
  accounts,
  identitySecurityEvents,
  platformAuditEvents,
  platformOperators,
  signals,
} from '../src/db/schema.js';
import {
  FOUNDATION_COMMUNITY_IDS,
  FOUNDATION_SIGNAL_IDS,
} from '../src/db/seeds/foundation-content.js';
import type {
  PlatformAccountActionResponse,
  PlatformAccountsResponse,
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
});

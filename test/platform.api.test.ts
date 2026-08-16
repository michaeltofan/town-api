import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import {
  accountSessions,
  accounts,
  identitySecurityEvents,
  membershipEntitlements,
  pilotCohortMembers,
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
  PlatformAlertActionResponse,
  PlatformAlertsResponse,
  PlatformDiscussionActionResponse,
  PlatformDiscussionsResponse,
  PlatformMembershipActionResponse,
  PlatformMembershipsResponse,
  PlatformPilotFunnelExportResponse,
  PlatformSessionResponse,
  PlatformInvestigationExportResponse,
  PlatformStatusResponse,
  PlatformSubmissionActionResponse,
  PlatformSubmissionDetailResponse,
  PlatformSubmissionsResponse,
  PlatformUptimeResponse,
} from '../src/schemas/platform.js';
import { recordUptimeObservation } from '../src/platform/services/record-uptime-observation.js';
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
      envOverrides: {
        SIGNAL_SUBMISSION_ENABLED: 'true',
      },
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
    expect(body.data.components.api.status).toBe('ok');
    expect(body.data.components.database.status).toBe('ok');
    expect(['ok', 'disabled', 'misconfigured', 'fail', 'timeout', 'degraded']).toContain(
      body.data.components.email.status,
    );
    expect(['ok', 'disabled', 'misconfigured', 'fail', 'timeout', 'degraded']).toContain(
      body.data.components.stripe.status,
    );
    expect(['ok', 'disabled', 'misconfigured', 'fail', 'timeout', 'degraded']).toContain(
      body.data.components.backup.status,
    );
    expect(['ok', 'disabled', 'misconfigured', 'fail', 'timeout', 'degraded']).toContain(
      body.data.components.restore.status,
    );
    expect(body.data.counts.accounts.total).toBeGreaterThan(0);

    const audits = await ctx.app.database.db
      .select()
      .from(platformAuditEvents)
      .where(eq(platformAuditEvents.action, 'status_viewed'));
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  it('records uptime samples, lists alerts, and acknowledges as ops_admin', async () => {
    const operator = await registerMember('PlatformOperatorUptime+setup@example.com');
    await grantOperator(operator.accountId, 'ops_admin');
    const viewer = await registerMember('PlatformViewerUptime+setup@example.com');
    await grantOperator(viewer.accountId, 'viewer');

    await recordUptimeObservation(ctx.app.database.db, {
      sampledAt: clock.now,
      force: true,
      components: {
        api: { status: 'ok', detail: 'environment=test' },
        database: { status: 'fail', detail: 'connection=fail;migrations=unknown' },
        email: { status: 'disabled', detail: 'email_verification_disabled' },
        stripe: { status: 'disabled', detail: 'stripe_billing_disabled' },
        backup: { status: 'disabled', detail: 'backup_disabled' },
        restore: { status: 'disabled', detail: 'restore_drill_disabled' },
      },
      environment: 'test',
      service: 'town-api',
      version: '0.1.0',
      commitSha: 'abc1234',
    });

    const uptime = await ctx.app.inject({
      method: 'GET',
      url: '/v1/platform/uptime?limit=10',
      headers: { authorization: `Session ${operator.sessionToken}` },
    });
    expect(uptime.statusCode).toBe(200);
    const uptimeBody = uptime.json<PlatformUptimeResponse>();
    expect(uptimeBody.data.summary.sampleCount).toBeGreaterThanOrEqual(1);
    expect(uptimeBody.data.summary.openAlertCount).toBeGreaterThanOrEqual(1);
    expect(uptimeBody.data.samples[0]?.components.database).toBe('fail');

    const alerts = await ctx.app.inject({
      method: 'GET',
      url: '/v1/platform/alerts?state=open',
      headers: { authorization: `Session ${operator.sessionToken}` },
    });
    expect(alerts.statusCode).toBe(200);
    const alertsBody = alerts.json<PlatformAlertsResponse>();
    const databaseAlert = alertsBody.data.alerts.find((row) => row.component === 'database');
    expect(databaseAlert).toBeDefined();
    if (!databaseAlert) {
      throw new Error('expected open database alert');
    }
    expect(databaseAlert).toMatchObject({
      status: 'fail',
      severity: 'critical',
      acknowledgedAt: null,
    });

    const viewerAck = await ctx.app.inject({
      method: 'POST',
      url: `/v1/platform/alerts/${databaseAlert.id}/acknowledge`,
      headers: { authorization: `Session ${viewer.sessionToken}` },
    });
    expect(viewerAck.statusCode).toBe(404);

    const ack = await ctx.app.inject({
      method: 'POST',
      url: `/v1/platform/alerts/${databaseAlert.id}/acknowledge`,
      headers: { authorization: `Session ${operator.sessionToken}` },
    });
    expect(ack.statusCode).toBe(200);
    const ackBody = ack.json<PlatformAlertActionResponse>();
    expect(ackBody.data.changed).toBe(true);
    expect(ackBody.data.alert.acknowledgedByAccountId).toBe(operator.accountId);

    await recordUptimeObservation(ctx.app.database.db, {
      sampledAt: new Date(new Date(clock.now).getTime() + 120_000).toISOString(),
      force: true,
      components: {
        api: { status: 'ok', detail: null },
        database: { status: 'ok', detail: 'connection=ok;migrations=ok' },
        email: { status: 'disabled', detail: null },
        stripe: { status: 'disabled', detail: null },
        backup: { status: 'disabled', detail: null },
        restore: { status: 'disabled', detail: null },
      },
      environment: 'test',
      service: 'town-api',
      version: '0.1.0',
      commitSha: 'abc1234',
    });

    const openAfter = await ctx.app.inject({
      method: 'GET',
      url: '/v1/platform/alerts?state=open',
      headers: { authorization: `Session ${operator.sessionToken}` },
    });
    expect(openAfter.statusCode).toBe(200);
    expect(
      openAfter
        .json<PlatformAlertsResponse>()
        .data.alerts.some((row) => row.component === 'database'),
    ).toBe(false);
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

  it('tags a Pilot Madrid grant in pilot_cohort_members, once per account+cohort', async () => {
    const operator = await registerMember('PilotMadridOpsAdmin+setup@example.com');
    await grantOperator(operator.accountId, 'role_admin');
    const target = await registerAccountWithoutMembership(
      'PilotMadridGrantTarget+setup@example.com',
    );
    const grantKey = randomUUID();

    const grant = await ctx.app.inject({
      method: 'POST',
      url: '/v1/platform/memberships/grant',
      headers: { authorization: `Session ${operator.sessionToken}` },
      payload: {
        accountId: target.accountId,
        accessUntil: ACCESS_UNTIL,
        reason: 'Pilot Madrid 90-day free access',
        idempotencyKey: grantKey,
        cohort: 'madrid_pilot',
      },
    });
    expect(grant.statusCode).toBe(200);
    expect(grant.json<PlatformMembershipActionResponse>().data.changed).toBe(true);

    const cohortRows = await ctx.app.database.db
      .select()
      .from(pilotCohortMembers)
      .where(
        and(
          eq(pilotCohortMembers.accountId, target.accountId),
          eq(pilotCohortMembers.cohort, 'madrid_pilot'),
        ),
      );
    expect(cohortRows).toHaveLength(1);
    expect(cohortRows[0]?.grantedByAccountId).toBe(operator.accountId);
    expect(cohortRows[0]?.revokedAt).toBeNull();

    // Replaying the same idempotency key must not create a second cohort row.
    const grantReplay = await ctx.app.inject({
      method: 'POST',
      url: '/v1/platform/memberships/grant',
      headers: { authorization: `Session ${operator.sessionToken}` },
      payload: {
        accountId: target.accountId,
        accessUntil: ACCESS_UNTIL,
        reason: 'Pilot Madrid 90-day free access',
        idempotencyKey: grantKey,
        cohort: 'madrid_pilot',
      },
    });
    expect(grantReplay.statusCode).toBe(200);
    expect(grantReplay.json<PlatformMembershipActionResponse>().data.changed).toBe(false);

    const cohortRowsAfterReplay = await ctx.app.database.db
      .select()
      .from(pilotCohortMembers)
      .where(
        and(
          eq(pilotCohortMembers.accountId, target.accountId),
          eq(pilotCohortMembers.cohort, 'madrid_pilot'),
        ),
      );
    expect(cohortRowsAfterReplay).toHaveLength(1);

    // A grant without a cohort must never write a pilot_cohort_members row.
    const uncohortedTarget = await registerAccountWithoutMembership(
      'PilotMadridNoCohort+setup@example.com',
    );
    const uncohortedGrant = await ctx.app.inject({
      method: 'POST',
      url: '/v1/platform/memberships/grant',
      headers: { authorization: `Session ${operator.sessionToken}` },
      payload: {
        accountId: uncohortedTarget.accountId,
        accessUntil: ACCESS_UNTIL,
        reason: 'Ordinary comped access, not a pilot',
        idempotencyKey: randomUUID(),
      },
    });
    expect(uncohortedGrant.statusCode).toBe(200);
    const uncohortedRows = await ctx.app.database.db
      .select()
      .from(pilotCohortMembers)
      .where(eq(pilotCohortMembers.accountId, uncohortedTarget.accountId));
    expect(uncohortedRows).toHaveLength(0);
  });

  it('exports an aggregate Pilot Madrid funnel with no account identifiers', async () => {
    const operator = await registerMember('PilotMadridExportOpsAdmin+setup@example.com');
    await grantOperator(operator.accountId, 'role_admin');
    const target = await registerAccountWithoutMembership(
      'PilotMadridExportTarget+setup@example.com',
    );

    const grant = await ctx.app.inject({
      method: 'POST',
      url: '/v1/platform/memberships/grant',
      headers: { authorization: `Session ${operator.sessionToken}` },
      payload: {
        accountId: target.accountId,
        accessUntil: ACCESS_UNTIL,
        reason: 'Pilot Madrid 90-day free access',
        idempotencyKey: randomUUID(),
        cohort: 'madrid_pilot',
      },
    });
    expect(grant.statusCode).toBe(200);

    const exportResult = await ctx.app.inject({
      method: 'GET',
      url: '/v1/platform/pilot/funnel-export?communitySlug=madrid-es&cohort=madrid_pilot',
      headers: { authorization: `Session ${operator.sessionToken}` },
    });
    expect(exportResult.statusCode).toBe(200);
    const pack = exportResult.json<PlatformPilotFunnelExportResponse>().data;

    expect(pack.community).toEqual({ slug: 'madrid-es', displayName: 'Madrid' });
    expect(pack.cohort.name).toBe('madrid_pilot');
    expect(pack.cohort.activeMembers).toBeGreaterThanOrEqual(1);
    expect(typeof pack.signalConfirmations).toBe('number');
    expect(Array.isArray(pack.processes)).toBe(true);
    expect(typeof pack.funnel.stageEventCounts).toBe('object');
    expect(typeof pack.funnel.proposals).toBe('number');
    expect(typeof pack.funnel.votes).toBe('number');
    expect(typeof pack.funnel.mandates).toBe('number');
    expect(typeof pack.funnel.verificationConfirmations).toBe('number');

    // No account identifiers anywhere in the aggregate payload.
    expect(JSON.stringify(pack)).not.toContain(target.accountId);
    expect(JSON.stringify(pack)).not.toContain(operator.accountId);
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

  it('moderates submissions with reject/restore, audit, inventory, and role gates', async () => {
    const moderator = await registerMember('PlatformSubmissionMod+setup@example.com');
    await grantOperator(moderator.accountId, 'moderator');
    const roleAdmin = await registerMember('PlatformSubmissionRoleAdmin+setup@example.com');
    await grantOperator(roleAdmin.accountId, 'role_admin');
    const viewer = await registerMember('PlatformSubmissionViewer+setup@example.com');
    await grantOperator(viewer.accountId, 'viewer');
    const author = await registerMember('PlatformSubmissionAuthor+setup@example.com');
    // Operators + author registrations are intentionally sequential over the shared DB.

    const create = await ctx.app.inject({
      method: 'POST',
      url: '/v1/communities/milano-it/signal-submissions',
      headers: { authorization: `Session ${author.sessionToken}` },
      payload: {
        headline: 'Platform fixture submission tram delay',
        body: 'Controlled pending submission for platform moderation tests.',
      },
    });
    expect(create.statusCode).toBe(201);
    const submissionId = create.json<{ data: { id: string } }>().data.id;

    const inventory = await ctx.app.inject({
      method: 'GET',
      url: '/v1/platform/submissions?status=pending_review&communitySlug=milano-it',
      headers: { authorization: `Session ${viewer.sessionToken}` },
    });
    expect(inventory.statusCode).toBe(200);
    expect(inventory.json<PlatformSubmissionsResponse>().data.submissions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: submissionId,
          status: 'pending_review',
          allowedActions: ['reject'],
        }),
      ]),
    );

    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/v1/platform/submissions/${submissionId}`,
      headers: { authorization: `Session ${moderator.sessionToken}` },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json<PlatformSubmissionDetailResponse>()).toMatchObject({
      data: {
        id: submissionId,
        accountId: author.accountId,
        communitySlug: 'milano-it',
        status: 'pending_review',
        allowedActions: ['reject'],
      },
    });

    const viewerReject = await ctx.app.inject({
      method: 'POST',
      url: `/v1/platform/submissions/${submissionId}/reject`,
      headers: { authorization: `Session ${viewer.sessionToken}` },
      payload: { reason: 'spam' },
    });
    expect(viewerReject.statusCode).toBe(404);

    const reject = await ctx.app.inject({
      method: 'POST',
      url: `/v1/platform/submissions/${submissionId}/reject`,
      headers: { authorization: `Session ${moderator.sessionToken}` },
      payload: { reason: 'spam' },
    });
    expect(reject.statusCode).toBe(200);
    expect(reject.json<PlatformSubmissionActionResponse>()).toMatchObject({
      data: {
        id: submissionId,
        status: 'rejected',
        reviewReason: 'spam',
        changed: true,
        allowedActions: ['restore'],
      },
    });

    const rejectRetry = await ctx.app.inject({
      method: 'POST',
      url: `/v1/platform/submissions/${submissionId}/reject`,
      headers: { authorization: `Session ${moderator.sessionToken}` },
      payload: { reason: 'abusive' },
    });
    expect(rejectRetry.statusCode).toBe(200);
    expect(rejectRetry.json<PlatformSubmissionActionResponse>()).toMatchObject({
      data: { status: 'rejected', reviewReason: 'spam', changed: false },
    });

    const rejectedInventory = await ctx.app.inject({
      method: 'GET',
      url: `/v1/platform/submissions?status=rejected&q=${encodeURIComponent(submissionId)}`,
      headers: { authorization: `Session ${moderator.sessionToken}` },
    });
    expect(rejectedInventory.statusCode).toBe(200);
    expect(rejectedInventory.json<PlatformSubmissionsResponse>().data.submissions).toEqual([
      expect.objectContaining({
        id: submissionId,
        status: 'rejected',
        allowedActions: ['restore'],
      }),
    ]);

    const rejectAudits = await ctx.app.database.db
      .select()
      .from(platformAuditEvents)
      .where(
        and(
          eq(platformAuditEvents.action, 'submission_rejected'),
          eq(platformAuditEvents.targetAccountId, author.accountId),
        ),
      );
    expect(rejectAudits).toHaveLength(1);
    expect(rejectAudits[0]?.operatorAccountId).toBe(moderator.accountId);
    expect(rejectAudits[0]?.metadata).toMatchObject({
      contentType: 'signal_submission',
      submissionId,
      reason: 'spam',
      beforeStatus: 'pending_review',
      afterStatus: 'rejected',
    });

    const restore = await ctx.app.inject({
      method: 'POST',
      url: `/v1/platform/submissions/${submissionId}/restore`,
      headers: { authorization: `Session ${roleAdmin.sessionToken}` },
      payload: { reason: 'other' },
    });
    expect(restore.statusCode).toBe(200);
    expect(restore.json<PlatformSubmissionActionResponse>()).toMatchObject({
      data: {
        id: submissionId,
        status: 'pending_review',
        reviewReason: null,
        changed: true,
        allowedActions: ['reject'],
      },
    });

    const restoreRetry = await ctx.app.inject({
      method: 'POST',
      url: `/v1/platform/submissions/${submissionId}/restore`,
      headers: { authorization: `Session ${roleAdmin.sessionToken}` },
      payload: { reason: 'other' },
    });
    expect(restoreRetry.statusCode).toBe(200);
    expect(restoreRetry.json<PlatformSubmissionActionResponse>().data.changed).toBe(false);

    const restoreAudits = await ctx.app.database.db
      .select()
      .from(platformAuditEvents)
      .where(eq(platformAuditEvents.action, 'submission_restored'));
    expect(
      restoreAudits.some(
        (event) =>
          event.operatorAccountId === roleAdmin.accountId &&
          (event.metadata as { submissionId?: string } | null)?.submissionId === submissionId,
      ),
    ).toBe(true);

    const signalStillModeratable = await ctx.app.inject({
      method: 'POST',
      url: `/v1/platform/signals/${FOUNDATION_SIGNAL_IDS.milanoSignal1}/hide`,
      headers: { authorization: `Session ${moderator.sessionToken}` },
      payload: { reason: 'off_topic' },
    });
    expect(signalStillModeratable.statusCode).toBe(200);
    await ctx.app.inject({
      method: 'POST',
      url: `/v1/platform/signals/${FOUNDATION_SIGNAL_IDS.milanoSignal1}/unhide`,
      headers: { authorization: `Session ${moderator.sessionToken}` },
    });

    const membershipsStillReadable = await ctx.app.inject({
      method: 'GET',
      url: '/v1/platform/memberships?limit=5',
      headers: { authorization: `Session ${moderator.sessionToken}` },
    });
    expect(membershipsStillReadable.statusCode).toBe(200);
  }, 180_000);

  it('moderates discussion contributions with hide/unhide, visibility, and role gates', async () => {
    const moderator = await registerMember('PlatformDiscussionMod+setup@example.com');
    await grantOperator(moderator.accountId, 'moderator');
    const viewer = await registerMember('PlatformDiscussionViewer+setup@example.com');
    await grantOperator(viewer.accountId, 'viewer');
    const investigator = await registerMember('PlatformDiscussionInvestigator+setup@example.com');
    await grantOperator(investigator.accountId, 'investigator');
    const author = await registerMember('PlatformDiscussionAuthor+setup@example.com');
    const signalId = FOUNDATION_SIGNAL_IDS.milanoSignal1;
    const contributionText = 'Platform fixture discussion contribution for hide tests.';

    const contribute = await ctx.app.inject({
      method: 'POST',
      url: `/v1/signals/${signalId}/discussion-session/contributions`,
      headers: { authorization: `Session ${author.sessionToken}` },
      payload: { text: contributionText, intent: 'observation' },
    });
    expect(contribute.statusCode).toBe(201);
    const contributions = contribute.json<{
      data: { contributions: { id: string; text: string }[] };
    }>().data.contributions;
    const contribution = contributions.find((row) => row.text === contributionText);
    expect(contribution).toBeDefined();
    if (!contribution) {
      throw new Error('expected fixture contribution');
    }
    const contributionId = contribution.id;

    const inventory = await ctx.app.inject({
      method: 'GET',
      url: `/v1/platform/discussions?q=${encodeURIComponent('Platform fixture discussion')}`,
      headers: { authorization: `Session ${viewer.sessionToken}` },
    });
    expect(inventory.statusCode).toBe(200);
    expect(inventory.json<PlatformDiscussionsResponse>().data.contributions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          contributionId,
          accountId: author.accountId,
          hidden: false,
          allowedActions: ['hide'],
        }),
      ]),
    );

    const insufficientHide = await ctx.app.inject({
      method: 'POST',
      url: `/v1/platform/discussions/${contributionId}/hide`,
      headers: { authorization: `Session ${investigator.sessionToken}` },
      payload: { reason: 'spam' },
    });
    expect(insufficientHide.statusCode).toBe(404);

    const hide = await ctx.app.inject({
      method: 'POST',
      url: `/v1/platform/discussions/${contributionId}/hide`,
      headers: { authorization: `Session ${moderator.sessionToken}` },
      payload: { reason: 'spam' },
    });
    expect(hide.statusCode).toBe(200);
    expect(hide.json<PlatformDiscussionActionResponse>()).toMatchObject({
      data: {
        contributionId,
        accountId: author.accountId,
        signalId,
        hidden: true,
        hiddenReason: 'spam',
        changed: true,
        allowedActions: ['unhide'],
      },
    });

    const hideRetry = await ctx.app.inject({
      method: 'POST',
      url: `/v1/platform/discussions/${contributionId}/hide`,
      headers: { authorization: `Session ${moderator.sessionToken}` },
      payload: { reason: 'abusive' },
    });
    expect(hideRetry.statusCode).toBe(200);
    expect(hideRetry.json<PlatformDiscussionActionResponse>()).toMatchObject({
      data: { hidden: true, hiddenReason: 'spam', changed: false },
    });

    const publicSession = await ctx.app.inject({
      method: 'GET',
      url: `/v1/signals/${signalId}/discussion-session`,
      headers: { authorization: `Session ${author.sessionToken}` },
    });
    expect(publicSession.statusCode).toBe(200);
    const publicContributions = publicSession.json<{
      data: { contributions: { id: string }[] };
    }>().data.contributions;
    expect(publicContributions.some((row) => row.id === contributionId)).toBe(false);

    const hiddenInventory = await ctx.app.inject({
      method: 'GET',
      url: '/v1/platform/discussions?hiddenOnly=true',
      headers: { authorization: `Session ${moderator.sessionToken}` },
    });
    expect(hiddenInventory.statusCode).toBe(200);
    expect(hiddenInventory.json<PlatformDiscussionsResponse>().data.contributions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ contributionId, hidden: true, allowedActions: ['unhide'] }),
      ]),
    );

    const hideAudits = await ctx.app.database.db
      .select()
      .from(platformAuditEvents)
      .where(eq(platformAuditEvents.action, 'discussion_contribution_hidden'));
    expect(
      hideAudits.some(
        (event) =>
          event.operatorAccountId === moderator.accountId &&
          event.targetSignalId === signalId &&
          (event.metadata as { contributionId?: string } | null)?.contributionId === contributionId,
      ),
    ).toBe(true);

    const unhide = await ctx.app.inject({
      method: 'POST',
      url: `/v1/platform/discussions/${contributionId}/unhide`,
      headers: { authorization: `Session ${moderator.sessionToken}` },
      payload: { reason: 'other' },
    });
    expect(unhide.statusCode).toBe(200);
    expect(unhide.json<PlatformDiscussionActionResponse>()).toMatchObject({
      data: { contributionId, hidden: false, changed: true, allowedActions: ['hide'] },
    });

    const unhideRetry = await ctx.app.inject({
      method: 'POST',
      url: `/v1/platform/discussions/${contributionId}/unhide`,
      headers: { authorization: `Session ${moderator.sessionToken}` },
      payload: { reason: 'other' },
    });
    expect(unhideRetry.statusCode).toBe(200);
    expect(unhideRetry.json<PlatformDiscussionActionResponse>().data.changed).toBe(false);

    const restoredPublic = await ctx.app.inject({
      method: 'GET',
      url: `/v1/signals/${signalId}/discussion-session`,
      headers: { authorization: `Session ${author.sessionToken}` },
    });
    expect(
      restoredPublic
        .json<{ data: { contributions: { id: string }[] } }>()
        .data.contributions.some((row) => row.id === contributionId),
    ).toBe(true);

    const unhideAudits = await ctx.app.database.db
      .select()
      .from(platformAuditEvents)
      .where(eq(platformAuditEvents.action, 'discussion_contribution_unhidden'));
    expect(
      unhideAudits.some(
        (event) =>
          (event.metadata as { contributionId?: string } | null)?.contributionId === contributionId,
      ),
    ).toBe(true);
  }, 180_000);

  it('exports a bounded investigation pack for investigators and gates viewers', async () => {
    const investigator = await registerMember('PlatformExportInvestigator+setup@example.com');
    await grantOperator(investigator.accountId, 'investigator');
    const viewer = await registerMember('PlatformExportViewer+setup@example.com');
    await grantOperator(viewer.accountId, 'viewer');
    const subject = await registerMember('PlatformExportSubject+setup@example.com');

    const viewerDenied = await ctx.app.inject({
      method: 'GET',
      url: `/v1/platform/accounts/${subject.accountId}/export`,
      headers: { authorization: `Session ${viewer.sessionToken}` },
    });
    expect(viewerDenied.statusCode).toBe(404);

    const exported = await ctx.app.inject({
      method: 'GET',
      url: `/v1/platform/accounts/${subject.accountId}/export`,
      headers: { authorization: `Session ${investigator.sessionToken}` },
    });
    expect(exported.statusCode).toBe(200);
    const body = exported.json<PlatformInvestigationExportResponse>();
    expect(body.data.accountId).toBe(subject.accountId);
    expect(body.data.account.accountId).toBe(subject.accountId);
    expect(body.data.emails.emails.length).toBeGreaterThan(0);
    expect(body.data.payments.stripeCustomer.linked).toBe(false);
    expect(Array.isArray(body.data.platformAudit.events)).toBe(true);
    expect(JSON.stringify(body.data)).not.toMatch(/cus_|cs_test_|sk_live_|sk_test_/);

    const audits = await ctx.app.database.db
      .select()
      .from(platformAuditEvents)
      .where(eq(platformAuditEvents.action, 'investigation_exported'));
    expect(
      audits.some(
        (event) =>
          event.operatorAccountId === investigator.accountId &&
          event.targetAccountId === subject.accountId,
      ),
    ).toBe(true);
  }, 180_000);
});

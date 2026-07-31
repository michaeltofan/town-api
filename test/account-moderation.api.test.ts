import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { accountSessions, accounts, identitySecurityEvents } from '../src/db/schema.js';
import {
  FOUNDATION_COMMUNITY_IDS,
  FOUNDATION_SIGNAL_IDS,
} from '../src/db/seeds/foundation-content.js';
import type { AccountModerationResponse } from '../src/schemas/account-moderation.js';
import {
  activatePasskeyAccountAndLinkCommunity,
  activateTestMembership,
  createEligibleTestResolver,
  createMembershipTestApp,
} from './helpers/membership.js';
import { loginMobileSession } from './helpers/passkey-management.js';
import type { SoftPasskeyMaterial } from './helpers/webauthn-soft-authenticator.js';

const FIXED_NOW = '2026-07-28T12:00:00.000Z';
const ACCESS_UNTIL = '2030-01-01T00:00:00.000Z';

describe('owner account ban / unban', () => {
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
    return `anonymous-client-key-ban-${String(clientKeySeq).padStart(4, '0')}`;
  }

  async function registerOwner(email: string): Promise<{
    accountId: string;
    sessionToken: string;
    material: SoftPasskeyMaterial;
  }> {
    // Advance past ceremony rate-limit windows that accumulate across tests with a fixed clock.
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
    await ctx.app.database.db
      .update(accounts)
      .set({ isOwner: true, updatedAt: clock.now })
      .where(eq(accounts.id, registration.accountId));
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

  async function countActiveSessions(accountId: string): Promise<number> {
    const rows = await ctx.app.database.db
      .select()
      .from(accountSessions)
      .where(and(eq(accountSessions.accountId, accountId), isNull(accountSessions.revokedAt)));
    return rows.length;
  }

  it('owner bans an active member: status suspended, sessions revoked, no participate/session, audit with reason', async () => {
    const owner = await registerOwner('OwnerBanMember+setup@example.com');
    const member = await registerMember('MemberToBan+setup@example.com');
    expect(await countActiveSessions(member.accountId)).toBeGreaterThanOrEqual(1);

    const ban = await ctx.app.inject({
      method: 'POST',
      url: `/v1/accounts/${member.accountId}/ban`,
      headers: { authorization: `Session ${owner.sessionToken}` },
      payload: { reason: 'spam' },
    });
    expect(ban.statusCode).toBe(200);
    const banBody = ban.json<AccountModerationResponse>();
    expect(banBody).toMatchObject({
      data: {
        accountId: member.accountId,
        status: 'suspended',
        changed: true,
      },
    });
    expect(banBody.data.suspendedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const row = await ctx.app.database.db
      .select()
      .from(accounts)
      .where(eq(accounts.id, member.accountId))
      .then((rows) => rows[0]);
    expect(row?.status).toBe('suspended');
    expect(row?.suspendedAt).not.toBeNull();

    expect(await countActiveSessions(member.accountId)).toBe(0);
    const revoked = await ctx.app.database.db
      .select()
      .from(accountSessions)
      .where(eq(accountSessions.accountId, member.accountId));
    expect(revoked.length).toBeGreaterThanOrEqual(1);
    expect(revoked.every((s) => s.revocationReason === 'account_suspended')).toBe(true);

    // Old session no longer resolves / cannot participate.
    const confirm = await ctx.app.inject({
      method: 'PUT',
      url: `/v1/signals/${FOUNDATION_SIGNAL_IDS.milanoSignal1}/confirmation`,
      headers: { authorization: `Session ${member.sessionToken}` },
      payload: {},
    });
    expect(confirm.statusCode).toBe(401);

    const events = await ctx.app.database.db
      .select()
      .from(identitySecurityEvents)
      .where(
        and(
          eq(identitySecurityEvents.accountId, owner.accountId),
          eq(identitySecurityEvents.eventType, 'account_suspended'),
        ),
      );
    expect(events.length).toBeGreaterThanOrEqual(1);
    const latest = events[events.length - 1];
    expect(latest?.metadata).toMatchObject({
      targetAccountId: member.accountId,
      reason: 'spam',
    });
  });

  it('owner un-bans: status active, member can log in again; audit written', async () => {
    const owner = await registerOwner('OwnerUnbanMember+setup@example.com');
    const member = await registerMember('MemberToUnban+setup@example.com');

    await ctx.app.inject({
      method: 'POST',
      url: `/v1/accounts/${member.accountId}/ban`,
      headers: { authorization: `Session ${owner.sessionToken}` },
      payload: { reason: 'abusive' },
    });

    const unban = await ctx.app.inject({
      method: 'POST',
      url: `/v1/accounts/${member.accountId}/unban`,
      headers: { authorization: `Session ${owner.sessionToken}` },
      payload: {},
    });
    expect(unban.statusCode).toBe(200);
    expect(unban.json<AccountModerationResponse>()).toMatchObject({
      data: {
        accountId: member.accountId,
        status: 'active',
        suspendedAt: null,
        changed: true,
      },
    });

    const row = await ctx.app.database.db
      .select()
      .from(accounts)
      .where(eq(accounts.id, member.accountId))
      .then((rows) => rows[0]);
    expect(row?.status).toBe('active');
    expect(row?.suspendedAt).toBeNull();

    // Old sessions stay revoked; member logs in again normally.
    expect(await countActiveSessions(member.accountId)).toBe(0);
    clock.now = new Date(new Date(clock.now).getTime() + 16 * 60_000).toISOString();
    const relogin = await loginMobileSession({
      app: ctx.app,
      material: member.material,
      signCount: 2,
      anonymousClientKey: nextAnonymousClientKey(),
    });
    expect(relogin.sessionToken.length).toBeGreaterThan(0);
    expect(await countActiveSessions(member.accountId)).toBe(1);

    const events = await ctx.app.database.db
      .select()
      .from(identitySecurityEvents)
      .where(
        and(
          eq(identitySecurityEvents.accountId, owner.accountId),
          eq(identitySecurityEvents.eventType, 'account_activated'),
        ),
      );
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[events.length - 1]?.metadata).toMatchObject({
      targetAccountId: member.accountId,
    });
  });

  it('rejects an invalid ban reason with VALIDATION_ERROR and no state change', async () => {
    const owner = await registerOwner('OwnerInvalidBanReason+setup@example.com');
    const member = await registerMember('MemberInvalidBanReason+setup@example.com');

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/v1/accounts/${member.accountId}/ban`,
      headers: { authorization: `Session ${owner.sessionToken}` },
      payload: { reason: 'not_a_real_reason' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });

    const row = await ctx.app.database.db
      .select()
      .from(accounts)
      .where(eq(accounts.id, member.accountId))
      .then((rows) => rows[0]);
    expect(row?.status).toBe('active');
    expect(row?.suspendedAt).toBeNull();
  });

  it('non-owner and no-session cannot ban or unban (generic NOT_FOUND, no state change)', async () => {
    const nonOwner = await registerMember('NonOwnerBanAttempt+setup@example.com');
    const target = await registerMember('TargetOfNonOwnerBan+setup@example.com');

    const noSessionBan = await ctx.app.inject({
      method: 'POST',
      url: `/v1/accounts/${target.accountId}/ban`,
      payload: { reason: 'spam' },
    });
    expect(noSessionBan.statusCode).toBe(404);
    expect(noSessionBan.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });

    const nonOwnerBan = await ctx.app.inject({
      method: 'POST',
      url: `/v1/accounts/${target.accountId}/ban`,
      headers: { authorization: `Session ${nonOwner.sessionToken}` },
      payload: { reason: 'spam' },
    });
    expect(nonOwnerBan.statusCode).toBe(404);
    expect(nonOwnerBan.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });

    const nonOwnerUnban = await ctx.app.inject({
      method: 'POST',
      url: `/v1/accounts/${target.accountId}/unban`,
      headers: { authorization: `Session ${nonOwner.sessionToken}` },
      payload: {},
    });
    expect(nonOwnerUnban.statusCode).toBe(404);
    expect(nonOwnerUnban.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });

    const row = await ctx.app.database.db
      .select()
      .from(accounts)
      .where(eq(accounts.id, target.accountId))
      .then((rows) => rows[0]);
    expect(row?.status).toBe('active');
  });

  it('owner cannot ban own account; owner cannot ban another owner (rejected, no state change)', async () => {
    const owner = await registerOwner('OwnerCannotBanSelf+setup@example.com');
    const otherOwner = await registerOwner('OtherOwnerCannotBan+setup@example.com');

    const selfBan = await ctx.app.inject({
      method: 'POST',
      url: `/v1/accounts/${owner.accountId}/ban`,
      headers: { authorization: `Session ${owner.sessionToken}` },
      payload: { reason: 'other' },
    });
    expect(selfBan.statusCode).toBe(403);
    expect(selfBan.json()).toMatchObject({ error: { code: 'CANNOT_BAN_SELF' } });

    const ownerRow = await ctx.app.database.db
      .select()
      .from(accounts)
      .where(eq(accounts.id, owner.accountId))
      .then((rows) => rows[0]);
    expect(ownerRow?.status).toBe('active');

    const otherBan = await ctx.app.inject({
      method: 'POST',
      url: `/v1/accounts/${otherOwner.accountId}/ban`,
      headers: { authorization: `Session ${owner.sessionToken}` },
      payload: { reason: 'illegal' },
    });
    expect(otherBan.statusCode).toBe(403);
    expect(otherBan.json()).toMatchObject({ error: { code: 'CANNOT_BAN_OWNER' } });

    const otherRow = await ctx.app.database.db
      .select()
      .from(accounts)
      .where(eq(accounts.id, otherOwner.accountId))
      .then((rows) => rows[0]);
    expect(otherRow?.status).toBe('active');
  });

  it('banning a non-active (pending/closed) account is a no-op (changed=false, no state corruption)', async () => {
    const owner = await registerOwner('OwnerBanNonActive+setup@example.com');

    // pending_email shell — never activated.
    const pendingId = 'a1000000-0000-4000-8000-00000000b001';
    await ctx.app.database.db.insert(accounts).values({
      id: pendingId,
      status: 'pending_email',
      isOwner: false,
      webauthnUserHandle: null,
      accountReadyAt: null,
      recoveryCompletedAt: null,
      suspendedAt: null,
      closedAt: null,
      createdAt: clock.now,
      updatedAt: clock.now,
    });

    const pendingBan = await ctx.app.inject({
      method: 'POST',
      url: `/v1/accounts/${pendingId}/ban`,
      headers: { authorization: `Session ${owner.sessionToken}` },
      payload: { reason: 'spam' },
    });
    expect(pendingBan.statusCode).toBe(200);
    expect(pendingBan.json<AccountModerationResponse>()).toMatchObject({
      data: {
        accountId: pendingId,
        status: 'pending_email',
        suspendedAt: null,
        changed: false,
      },
    });
    const pendingRow = await ctx.app.database.db
      .select()
      .from(accounts)
      .where(eq(accounts.id, pendingId))
      .then((rows) => rows[0]);
    expect(pendingRow?.status).toBe('pending_email');
    expect(pendingRow?.suspendedAt).toBeNull();

    // closed account (was active then closed).
    const member = await registerMember('MemberToCloseThenBan+setup@example.com');
    await ctx.app.database.db
      .update(accounts)
      .set({
        status: 'closed',
        closedAt: clock.now,
        suspendedAt: null,
        updatedAt: clock.now,
      })
      .where(eq(accounts.id, member.accountId));

    const closedBan = await ctx.app.inject({
      method: 'POST',
      url: `/v1/accounts/${member.accountId}/ban`,
      headers: { authorization: `Session ${owner.sessionToken}` },
      payload: { reason: 'off_topic' },
    });
    expect(closedBan.statusCode).toBe(200);
    expect(closedBan.json<AccountModerationResponse>()).toMatchObject({
      data: {
        accountId: member.accountId,
        status: 'closed',
        changed: false,
      },
    });
    const closedRow = await ctx.app.database.db
      .select()
      .from(accounts)
      .where(eq(accounts.id, member.accountId))
      .then((rows) => rows[0]);
    expect(closedRow?.status).toBe('closed');
    expect(closedRow?.closedAt).not.toBeNull();
    expect(closedRow?.suspendedAt).toBeNull();
  });

  it('idempotent: re-ban already-suspended and re-unban already-active are safe no-ops', async () => {
    const owner = await registerOwner('OwnerIdempotentBan+setup@example.com');
    const member = await registerMember('MemberIdempotentBan+setup@example.com');

    const firstBan = await ctx.app.inject({
      method: 'POST',
      url: `/v1/accounts/${member.accountId}/ban`,
      headers: { authorization: `Session ${owner.sessionToken}` },
      payload: { reason: 'immoral' },
    });
    expect(firstBan.statusCode).toBe(200);
    const firstBody = firstBan.json<AccountModerationResponse>();
    expect(firstBody.data.changed).toBe(true);
    const firstSuspendedAt = firstBody.data.suspendedAt;

    const eventsBefore = await ctx.app.database.db
      .select()
      .from(identitySecurityEvents)
      .where(
        and(
          eq(identitySecurityEvents.accountId, owner.accountId),
          eq(identitySecurityEvents.eventType, 'account_suspended'),
        ),
      );
    const banEventCountBefore = eventsBefore.length;

    const secondBan = await ctx.app.inject({
      method: 'POST',
      url: `/v1/accounts/${member.accountId}/ban`,
      headers: { authorization: `Session ${owner.sessionToken}` },
      payload: { reason: 'other' },
    });
    expect(secondBan.statusCode).toBe(200);
    expect(secondBan.json<AccountModerationResponse>()).toMatchObject({
      data: {
        accountId: member.accountId,
        status: 'suspended',
        suspendedAt: firstSuspendedAt,
        changed: false,
      },
    });

    const eventsAfter = await ctx.app.database.db
      .select()
      .from(identitySecurityEvents)
      .where(
        and(
          eq(identitySecurityEvents.accountId, owner.accountId),
          eq(identitySecurityEvents.eventType, 'account_suspended'),
        ),
      );
    expect(eventsAfter.length).toBe(banEventCountBefore);

    const unbanFirst = await ctx.app.inject({
      method: 'POST',
      url: `/v1/accounts/${member.accountId}/unban`,
      headers: { authorization: `Session ${owner.sessionToken}` },
      payload: {},
    });
    expect(unbanFirst.json<AccountModerationResponse>().data.changed).toBe(true);

    const activatedBefore = await ctx.app.database.db
      .select()
      .from(identitySecurityEvents)
      .where(
        and(
          eq(identitySecurityEvents.accountId, owner.accountId),
          eq(identitySecurityEvents.eventType, 'account_activated'),
        ),
      );
    const activatedCountBefore = activatedBefore.length;

    const unbanSecond = await ctx.app.inject({
      method: 'POST',
      url: `/v1/accounts/${member.accountId}/unban`,
      headers: { authorization: `Session ${owner.sessionToken}` },
      payload: {},
    });
    expect(unbanSecond.statusCode).toBe(200);
    expect(unbanSecond.json<AccountModerationResponse>()).toMatchObject({
      data: {
        accountId: member.accountId,
        status: 'active',
        suspendedAt: null,
        changed: false,
      },
    });

    const activatedAfter = await ctx.app.database.db
      .select()
      .from(identitySecurityEvents)
      .where(
        and(
          eq(identitySecurityEvents.accountId, owner.accountId),
          eq(identitySecurityEvents.eventType, 'account_activated'),
        ),
      );
    expect(activatedAfter.length).toBe(activatedCountBefore);

    const finalRow = await ctx.app.database.db
      .select()
      .from(accounts)
      .where(eq(accounts.id, member.accountId))
      .then((rows) => rows[0]);
    expect(finalRow?.status).toBe('active');
  });

  it('a normal member with no ban is unaffected (no regression)', async () => {
    const member = await registerMember('NormalMemberUnaffected+setup@example.com');

    const row = await ctx.app.database.db
      .select()
      .from(accounts)
      .where(eq(accounts.id, member.accountId))
      .then((rows) => rows[0]);
    expect(row?.status).toBe('active');
    expect(row?.suspendedAt).toBeNull();
    expect(await countActiveSessions(member.accountId)).toBeGreaterThanOrEqual(1);

    const confirm = await ctx.app.inject({
      method: 'PUT',
      url: `/v1/signals/${FOUNDATION_SIGNAL_IDS.milanoSignal1}/confirmation`,
      headers: { authorization: `Session ${member.sessionToken}` },
      payload: {},
    });
    expect(confirm.statusCode).toBe(200);
  });

  it('owner suspended inventory lists banned accounts; non-owner gets NOT_FOUND', async () => {
    const owner = await registerOwner('OwnerSuspendedInventory+setup@example.com');
    const member = await registerMember('BannedForInventory+setup@example.com');
    const nonOwner = await registerMember('NonOwnerSuspendedInventory+setup@example.com');

    const ban = await ctx.app.inject({
      method: 'POST',
      url: `/v1/accounts/${member.accountId}/ban`,
      headers: { authorization: `Session ${owner.sessionToken}` },
      payload: { reason: 'spam' },
    });
    expect(ban.statusCode).toBe(200);

    const inventory = await ctx.app.inject({
      method: 'GET',
      url: '/v1/moderation/accounts/suspended',
      headers: { authorization: `Session ${owner.sessionToken}` },
    });
    expect(inventory.statusCode).toBe(200);
    const body = inventory.json<{
      data: { accounts: { accountId: string; email: string | null; suspendedAt: string }[] };
    }>();
    const row = body.data.accounts.find((entry) => entry.accountId === member.accountId);
    expect(row).toBeTruthy();
    expect(row?.email?.toLowerCase()).toContain('bannedforinventory');
    expect(row?.suspendedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const denied = await ctx.app.inject({
      method: 'GET',
      url: '/v1/moderation/accounts/suspended',
      headers: { authorization: `Session ${nonOwner.sessionToken}` },
    });
    expect(denied.statusCode).toBe(404);
  });
});

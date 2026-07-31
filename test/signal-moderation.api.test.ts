import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { accounts, identitySecurityEvents, signals } from '../src/db/schema.js';
import {
  FOUNDATION_COMMUNITY_IDS,
  FOUNDATION_SIGNAL_IDS,
} from '../src/db/seeds/foundation-content.js';
import type { SignalModerationResponse } from '../src/schemas/signal-moderation.js';
import {
  activatePasskeyAccountAndLinkCommunity,
  activateTestMembership,
  createEligibleTestResolver,
  createMembershipTestApp,
} from './helpers/membership.js';
import { loginMobileSession } from './helpers/passkey-management.js';

type SignalListResponse = {
  data: {
    signals: { id: string }[];
  };
};

type SignalDetailResponse = {
  data: {
    id: string;
  };
};

describe('owner signal hide / unhide', () => {
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

  async function registerOwner(email: string): Promise<{
    accountId: string;
    sessionToken: string;
  }> {
    const registration = await activatePasskeyAccountAndLinkCommunity({
      app: ctx.app,
      delivery: ctx.delivery,
      email,
      communityId: FOUNDATION_COMMUNITY_IDS.milanoIt,
    });
    await activateTestMembership(ctx.app, {
      accountId: registration.accountId,
      effectiveAt: '2026-07-17T12:00:00.000Z',
      accessUntil: '2030-01-01T00:00:00.000Z',
    });
    await ctx.app.database.db
      .update(accounts)
      .set({ isOwner: true, updatedAt: '2026-07-28T00:00:00.000Z' })
      .where(eq(accounts.id, registration.accountId));
    const login = await loginMobileSession({
      app: ctx.app,
      material: registration.material,
    });
    return { accountId: registration.accountId, sessionToken: login.sessionToken };
  }

  async function registerNonOwner(email: string): Promise<{
    accountId: string;
    sessionToken: string;
  }> {
    const registration = await activatePasskeyAccountAndLinkCommunity({
      app: ctx.app,
      delivery: ctx.delivery,
      email,
      communityId: FOUNDATION_COMMUNITY_IDS.milanoIt,
    });
    await activateTestMembership(ctx.app, {
      accountId: registration.accountId,
      effectiveAt: '2026-07-17T12:00:00.000Z',
      accessUntil: '2030-01-01T00:00:00.000Z',
    });
    const login = await loginMobileSession({
      app: ctx.app,
      material: registration.material,
    });
    return { accountId: registration.accountId, sessionToken: login.sessionToken };
  }

  async function clearHideState(signalId: string): Promise<void> {
    await ctx.app.database.db
      .update(signals)
      .set({
        hiddenAt: null,
        hiddenReason: null,
        hiddenByAccountId: null,
        updatedAt: '2026-07-28T00:00:00.000Z',
      })
      .where(eq(signals.id, signalId));
  }

  it('owner hides a published signal: disappears from list/detail/confirm; fields + audit set', async () => {
    const signalId = FOUNDATION_SIGNAL_IDS.milanoSignal1;
    await clearHideState(signalId);
    const owner = await registerOwner('OwnerHideSignal+setup@example.com');

    const hide = await ctx.app.inject({
      method: 'POST',
      url: `/v1/signals/${signalId}/hide`,
      headers: { authorization: `Session ${owner.sessionToken}` },
      payload: { reason: 'spam' },
    });
    expect(hide.statusCode).toBe(200);
    const hideBody = hide.json<SignalModerationResponse>();
    expect(hideBody).toMatchObject({
      data: {
        signalId,
        hidden: true,
        hiddenReason: 'spam',
        changed: true,
      },
    });
    expect(hideBody.data.hiddenAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const row = await ctx.app.database.db
      .select()
      .from(signals)
      .where(eq(signals.id, signalId))
      .then((rows) => rows[0]);
    expect(row?.hiddenAt).not.toBeNull();
    expect(row?.hiddenReason).toBe('spam');
    expect(row?.hiddenByAccountId).toBe(owner.accountId);

    const list = await ctx.app.inject({
      method: 'GET',
      url: '/v1/communities/milano-it/signals',
    });
    expect(list.statusCode).toBe(200);
    const listedIds = list.json<SignalListResponse>().data.signals.map((s) => s.id);
    expect(listedIds).not.toContain(signalId);

    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/v1/signals/${signalId}`,
    });
    expect(detail.statusCode).toBe(404);
    expect(detail.json()).toMatchObject({ error: { code: 'SIGNAL_NOT_FOUND' } });

    const confirm = await ctx.app.inject({
      method: 'PUT',
      url: `/v1/signals/${signalId}/confirmation`,
      headers: { authorization: `Session ${owner.sessionToken}` },
      payload: {},
    });
    expect(confirm.statusCode).toBe(404);
    expect(confirm.json()).toMatchObject({ error: { code: 'SIGNAL_NOT_FOUND' } });

    const events = await ctx.app.database.db
      .select()
      .from(identitySecurityEvents)
      .where(
        and(
          eq(identitySecurityEvents.accountId, owner.accountId),
          eq(identitySecurityEvents.eventType, 'signal_hidden'),
        ),
      );
    expect(events.length).toBeGreaterThanOrEqual(1);
    const latest = events[events.length - 1];
    expect(latest?.metadata).toMatchObject({ signalId, reason: 'spam' });
  });

  it('owner un-hides: signal reappears; fields cleared; audit written', async () => {
    const signalId = FOUNDATION_SIGNAL_IDS.milanoSignal2;
    await clearHideState(signalId);
    const owner = await registerOwner('OwnerUnhideSignal+setup@example.com');

    await ctx.app.inject({
      method: 'POST',
      url: `/v1/signals/${signalId}/hide`,
      headers: { authorization: `Session ${owner.sessionToken}` },
      payload: { reason: 'abusive' },
    });

    const unhide = await ctx.app.inject({
      method: 'POST',
      url: `/v1/signals/${signalId}/unhide`,
      headers: { authorization: `Session ${owner.sessionToken}` },
      payload: {},
    });
    expect(unhide.statusCode).toBe(200);
    expect(unhide.json<SignalModerationResponse>()).toMatchObject({
      data: {
        signalId,
        hidden: false,
        hiddenAt: null,
        hiddenReason: null,
        changed: true,
      },
    });

    const row = await ctx.app.database.db
      .select()
      .from(signals)
      .where(eq(signals.id, signalId))
      .then((rows) => rows[0]);
    expect(row?.hiddenAt).toBeNull();
    expect(row?.hiddenReason).toBeNull();
    expect(row?.hiddenByAccountId).toBeNull();

    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/v1/signals/${signalId}`,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json<SignalDetailResponse>().data.id).toBe(signalId);

    const list = await ctx.app.inject({
      method: 'GET',
      url: '/v1/communities/milano-it/signals',
    });
    expect(list.json<SignalListResponse>().data.signals.map((s) => s.id)).toContain(signalId);

    const events = await ctx.app.database.db
      .select()
      .from(identitySecurityEvents)
      .where(
        and(
          eq(identitySecurityEvents.accountId, owner.accountId),
          eq(identitySecurityEvents.eventType, 'signal_unhidden'),
        ),
      );
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[events.length - 1]?.metadata).toMatchObject({ signalId });
  });

  it('rejects an invalid hide reason with VALIDATION_ERROR and no state change', async () => {
    const signalId = FOUNDATION_SIGNAL_IDS.milanoSignal3;
    await clearHideState(signalId);
    const owner = await registerOwner('OwnerInvalidReason+setup@example.com');

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/v1/signals/${signalId}/hide`,
      headers: { authorization: `Session ${owner.sessionToken}` },
      payload: { reason: 'not_a_real_reason' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });

    const row = await ctx.app.database.db
      .select()
      .from(signals)
      .where(eq(signals.id, signalId))
      .then((rows) => rows[0]);
    expect(row?.hiddenAt).toBeNull();
  });

  it('non-owner and no-session cannot hide or unhide (generic NOT_FOUND, no state change)', async () => {
    const signalId = FOUNDATION_SIGNAL_IDS.munichSignal1;
    await clearHideState(signalId);
    const nonOwner = await registerNonOwner('NonOwnerHideAttempt+setup@example.com');

    const noSessionHide = await ctx.app.inject({
      method: 'POST',
      url: `/v1/signals/${signalId}/hide`,
      payload: { reason: 'spam' },
    });
    expect(noSessionHide.statusCode).toBe(404);
    expect(noSessionHide.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });

    const nonOwnerHide = await ctx.app.inject({
      method: 'POST',
      url: `/v1/signals/${signalId}/hide`,
      headers: { authorization: `Session ${nonOwner.sessionToken}` },
      payload: { reason: 'spam' },
    });
    expect(nonOwnerHide.statusCode).toBe(404);
    expect(nonOwnerHide.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });

    const nonOwnerUnhide = await ctx.app.inject({
      method: 'POST',
      url: `/v1/signals/${signalId}/unhide`,
      headers: { authorization: `Session ${nonOwner.sessionToken}` },
      payload: {},
    });
    expect(nonOwnerUnhide.statusCode).toBe(404);
    expect(nonOwnerUnhide.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });

    const row = await ctx.app.database.db
      .select()
      .from(signals)
      .where(eq(signals.id, signalId))
      .then((rows) => rows[0]);
    expect(row?.hiddenAt).toBeNull();
  });

  it('idempotent hide preserves original who/when/why; idempotent unhide is a no-op', async () => {
    const signalId = FOUNDATION_SIGNAL_IDS.munichSignal2;
    await clearHideState(signalId);
    const owner = await registerOwner('OwnerIdempotentHide+setup@example.com');

    const first = await ctx.app.inject({
      method: 'POST',
      url: `/v1/signals/${signalId}/hide`,
      headers: { authorization: `Session ${owner.sessionToken}` },
      payload: { reason: 'illegal' },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json<SignalModerationResponse>();
    expect(firstBody.data.changed).toBe(true);
    const firstHiddenAt = firstBody.data.hiddenAt;
    expect(firstHiddenAt).not.toBeNull();

    const second = await ctx.app.inject({
      method: 'POST',
      url: `/v1/signals/${signalId}/hide`,
      headers: { authorization: `Session ${owner.sessionToken}` },
      payload: { reason: 'other' },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json<SignalModerationResponse>()).toMatchObject({
      data: {
        signalId,
        hidden: true,
        hiddenReason: 'illegal',
        hiddenAt: firstHiddenAt,
        changed: false,
      },
    });

    const row = await ctx.app.database.db
      .select()
      .from(signals)
      .where(eq(signals.id, signalId))
      .then((rows) => rows[0]);
    expect(row?.hiddenReason).toBe('illegal');
    expect(row?.hiddenByAccountId).toBe(owner.accountId);

    const unhideFirst = await ctx.app.inject({
      method: 'POST',
      url: `/v1/signals/${signalId}/unhide`,
      headers: { authorization: `Session ${owner.sessionToken}` },
      payload: {},
    });
    expect(unhideFirst.json<SignalModerationResponse>().data.changed).toBe(true);

    const unhideSecond = await ctx.app.inject({
      method: 'POST',
      url: `/v1/signals/${signalId}/unhide`,
      headers: { authorization: `Session ${owner.sessionToken}` },
      payload: {},
    });
    expect(unhideSecond.statusCode).toBe(200);
    expect(unhideSecond.json<SignalModerationResponse>()).toMatchObject({
      data: {
        signalId,
        hidden: false,
        hiddenAt: null,
        hiddenReason: null,
        changed: false,
      },
    });
  });

  it('normal published non-hidden signal remains visible to users (no regression)', async () => {
    const signalId = FOUNDATION_SIGNAL_IDS.aradSignal1;
    await clearHideState(signalId);

    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/v1/signals/${signalId}`,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json<SignalDetailResponse>().data.id).toBe(signalId);

    const list = await ctx.app.inject({
      method: 'GET',
      url: '/v1/communities/arad-ro/signals',
    });
    expect(list.statusCode).toBe(200);
    expect(list.json<SignalListResponse>().data.signals.map((s) => s.id)).toContain(signalId);
  });

  it('owner moderation inventory includes hidden signals; non-owner gets NOT_FOUND', async () => {
    const signalId = FOUNDATION_SIGNAL_IDS.milanoSignal1;
    await clearHideState(signalId);
    const owner = await registerOwner('OwnerModerationInventory+setup@example.com');
    const nonOwner = await registerNonOwner('NonOwnerModerationInventory+setup@example.com');

    await ctx.app.inject({
      method: 'POST',
      url: `/v1/signals/${signalId}/hide`,
      headers: { authorization: `Session ${owner.sessionToken}` },
      payload: { reason: 'abusive' },
    });

    const ownerList = await ctx.app.inject({
      method: 'GET',
      url: '/v1/communities/milano-it/moderation/signals',
      headers: { authorization: `Session ${owner.sessionToken}` },
    });
    expect(ownerList.statusCode).toBe(200);
    const ownerBody = ownerList.json<{
      data: {
        community: { slug: string };
        signals: {
          id: string;
          hidden: boolean;
          hiddenReason: string | null;
          authorAccountId: string | null;
        }[];
      };
    }>();
    expect(ownerBody.data.community.slug).toBe('milano-it');
    const hiddenRow = ownerBody.data.signals.find((row) => row.id === signalId);
    expect(hiddenRow).toMatchObject({
      id: signalId,
      hidden: true,
      hiddenReason: 'abusive',
      authorAccountId: null,
    });

    const publicList = await ctx.app.inject({
      method: 'GET',
      url: '/v1/communities/milano-it/signals',
    });
    expect(publicList.json<SignalListResponse>().data.signals.map((row) => row.id)).not.toContain(
      signalId,
    );

    const denied = await ctx.app.inject({
      method: 'GET',
      url: '/v1/communities/milano-it/moderation/signals',
      headers: { authorization: `Session ${nonOwner.sessionToken}` },
    });
    expect(denied.statusCode).toBe(404);
  });
});

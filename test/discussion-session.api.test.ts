import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, count, eq } from 'drizzle-orm';
import {
  identitySecurityEvents,
  signalDiscussionContributions,
  signalDiscussionSessions,
} from '../src/db/schema.js';
import { FOUNDATION_SIGNAL_IDS } from '../src/db/seeds/foundation-content.js';
import {
  activatePasskeyAccountAndLinkCommunity,
  activateTestMembership,
  createEligibleTestResolver,
  createMembershipTestApp,
  FOUNDATION_COMMUNITY_IDS,
} from './helpers/membership.js';
import { loginMobileSession } from './helpers/passkey-management.js';

type DiscussionPayload = {
  data: {
    session: { id: string; signalId: string; createdAt: string };
    contributions: {
      id: string;
      authorDisplayName: string;
      text: string;
      intent: string;
      createdAt: string;
    }[];
  };
};

describe('signal discussion-session (participant)', () => {
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

  async function participantSession(email: string, communityId?: string) {
    const registration = await activatePasskeyAccountAndLinkCommunity({
      app: ctx.app,
      delivery: ctx.delivery,
      email,
      ...(communityId !== undefined ? { communityId } : {}),
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
    return { registration, login };
  }

  it('rejects missing session on GET and POST', async () => {
    const signalId = FOUNDATION_SIGNAL_IDS.milanoSignal1;
    const getResponse = await ctx.app.inject({
      method: 'GET',
      url: `/v1/signals/${signalId}/discussion-session`,
    });
    expect(getResponse.statusCode).toBe(401);
    expect(getResponse.json()).toMatchObject({ error: { code: 'SESSION_NOT_AUTHORIZED' } });

    const postResponse = await ctx.app.inject({
      method: 'POST',
      url: `/v1/signals/${signalId}/discussion-session/contributions`,
      payload: { text: 'A concrete local next step for this signal.', intent: 'next_step' },
    });
    expect(postResponse.statusCode).toBe(401);
    expect(postResponse.json()).toMatchObject({ error: { code: 'SESSION_NOT_AUTHORIZED' } });
  });

  it('rejects SetupGrant, RecoveryGrant, and Bearer', async () => {
    const signalId = FOUNDATION_SIGNAL_IDS.milanoSignal1;
    for (const scheme of ['SetupGrant', 'RecoveryGrant', 'Bearer'] as const) {
      const response = await ctx.app.inject({
        method: 'GET',
        url: `/v1/signals/${signalId}/discussion-session`,
        headers: { authorization: `${scheme} not-a-real-token` },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: 'SESSION_NOT_AUTHORIZED' } });
    }
  });

  it('rejects a session without entitlement without leaking denial reason', async () => {
    const registration = await activatePasskeyAccountAndLinkCommunity({
      app: ctx.app,
      delivery: ctx.delivery,
      email: 'DiscussionNoEntitlement+setup@example.com',
    });
    const login = await loginMobileSession({
      app: ctx.app,
      material: registration.material,
    });
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/v1/signals/${FOUNDATION_SIGNAL_IDS.milanoSignal1}/discussion-session`,
      headers: { authorization: `Session ${login.sessionToken}` },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: { code: 'CIVIC_PARTICIPATION_NOT_AUTHORIZED' },
    });
    expect(JSON.stringify(response.json())).not.toMatch(
      /no_entitlement|inactive_membership|actor_missing/,
    );
    const events = await ctx.app.database.db
      .select()
      .from(identitySecurityEvents)
      .where(
        and(
          eq(identitySecurityEvents.accountId, registration.accountId),
          eq(identitySecurityEvents.eventType, 'civic_participation_denied'),
        ),
      );
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects a participant bound to a different community', async () => {
    const { login } = await participantSession(
      'DiscussionWrongCommunity+setup@example.com',
      FOUNDATION_COMMUNITY_IDS.munichDe,
    );
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/v1/signals/${FOUNDATION_SIGNAL_IDS.milanoSignal1}/discussion-session/contributions`,
      headers: { authorization: `Session ${login.sessionToken}` },
      payload: {
        text: 'A Milano-only proposal that should be denied.',
        intent: 'proposal',
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: { code: 'CIVIC_PARTICIPATION_NOT_AUTHORIZED' },
    });
  });

  it('returns an empty session on GET and persists a contribution on POST', async () => {
    const { login } = await participantSession('DiscussionOk+setup@example.com');
    const signalId = FOUNDATION_SIGNAL_IDS.milanoSignal1;
    const headers = { authorization: `Session ${login.sessionToken}` };

    const empty = await ctx.app.inject({
      method: 'GET',
      url: `/v1/signals/${signalId}/discussion-session`,
      headers,
    });
    expect(empty.statusCode).toBe(200);
    const emptyBody = empty.json<DiscussionPayload>();
    expect(emptyBody.data.session.signalId).toBe(signalId);
    expect(emptyBody.data.contributions).toEqual([]);

    const created = await ctx.app.inject({
      method: 'POST',
      url: `/v1/signals/${signalId}/discussion-session/contributions`,
      headers,
      payload: {
        text: 'Observe the damaged pavement near the school gate each morning.',
        intent: 'observation',
      },
    });
    expect(created.statusCode).toBe(201);
    const createdBody = created.json<DiscussionPayload>();
    expect(createdBody.data.session.id).toBe(emptyBody.data.session.id);
    expect(createdBody.data.contributions).toHaveLength(1);
    expect(createdBody.data.contributions[0]).toMatchObject({
      authorDisplayName: 'TOWN member',
      text: 'Observe the damaged pavement near the school gate each morning.',
      intent: 'observation',
    });
    expect(createdBody.data.contributions[0]?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(JSON.stringify(createdBody)).not.toMatch(/actorId|accountId/);

    const reread = await ctx.app.inject({
      method: 'GET',
      url: `/v1/signals/${signalId}/discussion-session`,
      headers,
    });
    expect(reread.statusCode).toBe(200);
    expect(reread.json()).toEqual(createdBody);

    const sessionRows = await ctx.app.database.db
      .select({ value: count() })
      .from(signalDiscussionSessions)
      .where(eq(signalDiscussionSessions.signalId, signalId));
    expect(sessionRows[0]?.value).toBe(1);

    const contributionRows = await ctx.app.database.db
      .select({ value: count() })
      .from(signalDiscussionContributions)
      .where(eq(signalDiscussionContributions.signalId, signalId));
    expect(contributionRows[0]?.value).toBe(1);
  });

  it('rejects short text, unknown intent, and unknown body properties', async () => {
    const { login } = await participantSession('DiscussionValidation+setup@example.com');
    const headers = { authorization: `Session ${login.sessionToken}` };
    const url = `/v1/signals/${FOUNDATION_SIGNAL_IDS.milanoSignal2}/discussion-session/contributions`;

    const shortText = await ctx.app.inject({
      method: 'POST',
      url,
      headers,
      payload: { text: 'too short', intent: 'proposal' },
    });
    expect(shortText.statusCode).toBe(400);
    expect(shortText.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });

    const badIntent = await ctx.app.inject({
      method: 'POST',
      url,
      headers,
      payload: {
        text: 'A concrete proposal that uses an invalid intent value.',
        intent: 'chat',
      },
    });
    expect(badIntent.statusCode).toBe(400);

    const extraProp = await ctx.app.inject({
      method: 'POST',
      url,
      headers,
      payload: {
        text: 'A concrete proposal with an unexpected property attached.',
        intent: 'proposal',
        replyTo: 'someone',
      },
    });
    expect(extraProp.statusCode).toBe(400);
  });

  it('returns 404 for an unknown signal id', async () => {
    const { login } = await participantSession('DiscussionMissingSignal+setup@example.com');
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/v1/signals/00000000-0000-4000-8000-00000000dead/discussion-session',
      headers: { authorization: `Session ${login.sessionToken}` },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'SIGNAL_NOT_FOUND' } });
  });
});

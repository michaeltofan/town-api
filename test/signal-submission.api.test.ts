import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, count, eq } from 'drizzle-orm';
import { actors, signalSubmissions } from '../src/db/schema.js';
import { FOUNDATION_COMMUNITY_IDS } from '../src/db/seeds/foundation-content.js';
import { insertSignalSubmission } from '../src/db/repositories/signal-submissions.js';
import {
  activatePasskeyAccountAndLinkCommunity,
  activateTestMembership,
  createEligibleTestResolver,
  createMembershipTestApp,
} from './helpers/membership.js';
import { loginMobileSession } from './helpers/passkey-management.js';

const FIXED_NOW = '2026-07-23T12:00:00.000Z';
const ACCESS_UNTIL = '2026-12-31T00:00:00.000Z';

describe('POST /v1/communities/:communitySlug/signal-submissions', () => {
  let ctx: Awaited<ReturnType<typeof createMembershipTestApp>>;
  let clock: { now: string };

  beforeAll(async () => {
    clock = { now: FIXED_NOW };
    ctx = await createMembershipTestApp({
      now: () => clock.now,
      localEligibilityResolver: createEligibleTestResolver(),
      envOverrides: {
        SIGNAL_SUBMISSION_ENABLED: 'true',
      },
      poolMax: 10,
    });
  });

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  async function registerMember(input: {
    email: string;
    communityId?: string;
    linkCommunity?: boolean;
    activateMembership?: boolean;
  }) {
    // Advance past ceremony rate-limit windows that accumulate across tests with a fixed clock.
    clock.now = new Date(new Date(clock.now).getTime() + 16 * 60_000).toISOString();
    const registration = await activatePasskeyAccountAndLinkCommunity({
      app: ctx.app,
      delivery: ctx.delivery,
      email: input.email,
      communityId: input.communityId ?? FOUNDATION_COMMUNITY_IDS.milanoIt,
      ...(input.linkCommunity !== undefined ? { linkCommunity: input.linkCommunity } : {}),
    });
    if (input.activateMembership !== false) {
      await activateTestMembership(ctx.app, {
        accountId: registration.accountId,
        effectiveAt: clock.now,
        accessUntil: ACCESS_UNTIL,
        now: clock.now,
      });
    }
    const login = await loginMobileSession({
      app: ctx.app,
      material: registration.material,
      userHandle: registration.userHandle,
    });
    return { ...registration, login };
  }

  async function submit(input: {
    sessionToken: string;
    slug?: string;
    headline?: string;
    body?: string;
    extra?: Record<string, unknown>;
  }) {
    return ctx.app.inject({
      method: 'POST',
      url: `/v1/communities/${input.slug ?? 'milano-it'}/signal-submissions`,
      headers: { authorization: `Session ${input.sessionToken}` },
      payload: {
        headline: input.headline ?? 'A local observation',
        body: input.body ?? 'Details about what is happening on the street.',
        ...(input.extra ?? {}),
      },
    });
  }

  it('returns 404 NOT_FOUND when SIGNAL_SUBMISSION_ENABLED is false', async () => {
    const off = await createMembershipTestApp({
      now: () => FIXED_NOW,
      localEligibilityResolver: createEligibleTestResolver(),
      envOverrides: {
        SIGNAL_SUBMISSION_ENABLED: 'false',
      },
    });
    try {
      const member = await activatePasskeyAccountAndLinkCommunity({
        app: off.app,
        delivery: off.delivery,
        email: 'signal.flagoff@example.com',
      });
      await activateTestMembership(off.app, {
        accountId: member.accountId,
        effectiveAt: FIXED_NOW,
        accessUntil: ACCESS_UNTIL,
        now: FIXED_NOW,
      });
      const login = await loginMobileSession({
        app: off.app,
        material: member.material,
        userHandle: member.userHandle,
      });
      const response = await off.app.inject({
        method: 'POST',
        url: '/v1/communities/milano-it/signal-submissions',
        headers: { authorization: `Session ${login.sessionToken}` },
        payload: { headline: 'Hello', body: 'World' },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    } finally {
      await off.app.close();
      await off.pool.end();
    }
  });

  it('rejects missing session with SESSION_NOT_AUTHORIZED', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/communities/milano-it/signal-submissions',
      payload: { headline: 'Hello', body: 'World' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'SESSION_NOT_AUTHORIZED' } });
  });

  it('rejects unknown body properties with VALIDATION_ERROR', async () => {
    const member = await registerMember({ email: 'signal.unknown-prop@example.com' });
    const response = await submit({
      sessionToken: member.login.sessionToken,
      extra: { photo: 'nope' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('rejects empty values after trimming with VALIDATION_ERROR', async () => {
    const member = await registerMember({ email: 'signal.empty-trim@example.com' });
    const response = await submit({
      sessionToken: member.login.sessionToken,
      headline: '   ',
      body: '   ',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('rejects over-length values after trimming with VALIDATION_ERROR', async () => {
    const member = await registerMember({ email: 'signal.overlength@example.com' });
    const response = await submit({
      sessionToken: member.login.sessionToken,
      headline: `  ${'h'.repeat(161)}  `,
      body: 'ok body',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });

    const responseBody = await submit({
      sessionToken: member.login.sessionToken,
      headline: 'ok',
      body: `  ${'b'.repeat(2001)}  `,
    });
    expect(responseBody.statusCode).toBe(400);
    expect(responseBody.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('returns 404 COMMUNITY_NOT_FOUND for unknown slug', async () => {
    const member = await registerMember({ email: 'signal.unknown-slug@example.com' });
    const response = await submit({
      sessionToken: member.login.sessionToken,
      slug: 'no-such-city-xx',
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'COMMUNITY_NOT_FOUND' } });
  });

  it('creates a pending_review submission on success', async () => {
    const member = await registerMember({ email: 'signal.success@example.com' });
    const response = await submit({
      sessionToken: member.login.sessionToken,
      headline: '  Tram delay near Duomo  ',
      body: '  Crowds waiting at the stop.  ',
    });
    expect(response.statusCode).toBe(201);
    const body = response.json<{
      data: {
        id: string;
        status: string;
        community: { slug: string };
        createdAt: string;
      };
    }>();
    expect(body.data.status).toBe('pending_review');
    expect(body.data.community.slug).toBe('milano-it');
    expect(body.data.createdAt).toBe(clock.now);
    expect(body.data.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    const rows = await ctx.app.database.db
      .select()
      .from(signalSubmissions)
      .where(eq(signalSubmissions.id, body.data.id))
      .limit(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.headline).toBe('Tram delay near Duomo');
    expect(rows[0]?.body).toBe('Crowds waiting at the stop.');
    expect(rows[0]?.status).toBe('pending_review');
    expect(rows[0]?.accountId).toBe(member.accountId);
    expect(rows[0]?.actorId).toBe(member.actorId);
    expect(rows[0]?.communityId).toBe(FOUNDATION_COMMUNITY_IDS.milanoIt);
  });

  it('denies civic-access community mismatch with CIVIC_PARTICIPATION_NOT_AUTHORIZED', async () => {
    const member = await registerMember({
      email: 'signal.mismatch@example.com',
      communityId: FOUNDATION_COMMUNITY_IDS.munichDe,
    });
    const response = await submit({
      sessionToken: member.login.sessionToken,
      slug: 'milano-it',
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: { code: 'CIVIC_PARTICIPATION_NOT_AUTHORIZED' },
    });
  });

  it('denies civic-access when membership is not active', async () => {
    const member = await registerMember({
      email: 'signal.no-membership@example.com',
      activateMembership: false,
    });
    const response = await submit({ sessionToken: member.login.sessionToken });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: { code: 'CIVIC_PARTICIPATION_NOT_AUTHORIZED' },
    });
  });

  it('returns bounded CIVIC_PARTICIPATION_NOT_AUTHORIZED when linked civic actor is missing (not 500)', async () => {
    const member = await registerMember({ email: 'signal.no-actor@example.com' });
    await ctx.app.database.db
      .update(actors)
      .set({ accountId: null })
      .where(eq(actors.accountId, member.accountId));

    const response = await submit({ sessionToken: member.login.sessionToken });
    expect(response.statusCode).toBe(403);
    expect(response.statusCode).not.toBe(500);
    expect(response.json()).toMatchObject({
      error: { code: 'CIVIC_PARTICIPATION_NOT_AUTHORIZED' },
    });
  });

  it('returns 429 on the sixth submission within a rolling 24 hours', async () => {
    const member = await registerMember({ email: 'signal.rate-limit@example.com' });
    for (let i = 0; i < 5; i += 1) {
      const response = await submit({
        sessionToken: member.login.sessionToken,
        headline: `Observation ${String(i)}`,
        body: `Body ${String(i)}`,
      });
      expect(response.statusCode).toBe(201);
    }
    const sixth = await submit({
      sessionToken: member.login.sessionToken,
      headline: 'Sixth',
      body: 'Should be rate limited',
    });
    expect(sixth.statusCode).toBe(429);
    expect(sixth.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
  });

  it('uses a rolling 24-hour window, not a calendar day', async () => {
    const member = await registerMember({ email: 'signal.rolling-window@example.com' });
    const nowMs = new Date(clock.now).getTime();
    const oldCreatedAt = new Date(nowMs - 25 * 60 * 60_000).toISOString();
    for (let i = 0; i < 5; i += 1) {
      await insertSignalSubmission(ctx.app.database.db, {
        id: `30000000-0000-4000-8000-00000000010${String(i)}`,
        accountId: member.accountId,
        actorId: member.actorId,
        communityId: FOUNDATION_COMMUNITY_IDS.milanoIt,
        headline: `Old ${String(i)}`,
        body: `Old body ${String(i)}`,
        createdAt: oldCreatedAt,
        updatedAt: oldCreatedAt,
      });
    }
    const response = await submit({
      sessionToken: member.login.sessionToken,
      headline: 'Fresh within window',
      body: 'Should succeed because prior rows are outside the rolling window',
    });
    expect(response.statusCode).toBe(201);
  });

  it('concurrent sixth submissions with four existing yield one 201 and one 429 and five rows', async () => {
    const member = await registerMember({ email: 'signal.concurrency@example.com' });
    for (let i = 0; i < 4; i += 1) {
      const response = await submit({
        sessionToken: member.login.sessionToken,
        headline: `Seed ${String(i)}`,
        body: `Seed body ${String(i)}`,
      });
      expect(response.statusCode).toBe(201);
    }

    const [first, second] = await Promise.all([
      submit({
        sessionToken: member.login.sessionToken,
        headline: 'Concurrent A',
        body: 'Concurrent body A',
      }),
      submit({
        sessionToken: member.login.sessionToken,
        headline: 'Concurrent B',
        body: 'Concurrent body B',
      }),
    ]);

    const statuses = [first.statusCode, second.statusCode].sort((a, b) => a - b);
    expect(statuses).toEqual([201, 429]);

    const totals = await ctx.app.database.db
      .select({ value: count() })
      .from(signalSubmissions)
      .where(
        and(
          eq(signalSubmissions.accountId, member.accountId),
          eq(signalSubmissions.status, 'pending_review'),
        ),
      );
    expect(Number(totals[0]?.value)).toBe(5);
  });
});

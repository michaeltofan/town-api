import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, count, eq } from 'drizzle-orm';
import { actors, identitySecurityEvents, signalConfirmations } from '../src/db/schema.js';
import { CONTROLLED_TEST_ACTOR_ID } from '../src/db/seeds/controlled-actor-content.js';
import {
  FOUNDATION_COMMUNITY_IDS,
  FOUNDATION_SIGNAL_IDS,
} from '../src/db/seeds/foundation-content.js';
import {
  activatePasskeyAccountAndLinkCommunity,
  activateTestMembership,
  createEligibleTestResolver,
  createMembershipTestApp,
} from './helpers/membership.js';
import { loginMobileSession } from './helpers/passkey-management.js';
import { createDefaultLocalEligibilityResolver } from '../src/membership/local-eligibility.js';

describe('PUT /v1/signals/:signalId/confirmation (participant)', () => {
  describe('with eligible local resolver injected', () => {
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

    it('rejects missing session', async () => {
      const response = await ctx.app.inject({
        method: 'PUT',
        url: `/v1/signals/${FOUNDATION_SIGNAL_IDS.milanoSignal1}/confirmation`,
        payload: {},
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: 'SESSION_NOT_AUTHORIZED' } });
    });

    it('rejects control key alone without a session on PUT', async () => {
      const response = await ctx.app.inject({
        method: 'PUT',
        url: `/v1/signals/${FOUNDATION_SIGNAL_IDS.milanoSignal1}/confirmation`,
        headers: { 'x-town-control-key': 'town-controlled-test-key-local-only' },
        payload: {},
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: 'SESSION_NOT_AUTHORIZED' } });
    });

    it('rejects SetupGrant, RecoveryGrant, and Bearer on PUT', async () => {
      for (const scheme of ['SetupGrant', 'RecoveryGrant', 'Bearer'] as const) {
        const response = await ctx.app.inject({
          method: 'PUT',
          url: `/v1/signals/${FOUNDATION_SIGNAL_IDS.milanoSignal1}/confirmation`,
          headers: { authorization: `${scheme} not-a-real-token` },
          payload: {},
        });
        expect(response.statusCode).toBe(401);
        expect(response.json()).toMatchObject({ error: { code: 'SESSION_NOT_AUTHORIZED' } });
      }
    });

    it('rejects a session without an active entitlement with CIVIC_PARTICIPATION_NOT_AUTHORIZED', async () => {
      const registration = await activatePasskeyAccountAndLinkCommunity({
        app: ctx.app,
        delivery: ctx.delivery,
        email: 'ConfirmationNoEntitlement+setup@example.com',
      });
      const login = await loginMobileSession({
        app: ctx.app,
        material: registration.material,
      });
      const response = await ctx.app.inject({
        method: 'PUT',
        url: `/v1/signals/${FOUNDATION_SIGNAL_IDS.milanoSignal1}/confirmation`,
        headers: { authorization: `Session ${login.sessionToken}` },
        payload: {},
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        error: { code: 'CIVIC_PARTICIPATION_NOT_AUTHORIZED' },
      });
      // Denial reason must not leak into the API response body.
      expect(JSON.stringify(response.json())).not.toMatch(
        /no_entitlement|inactive_membership|actor_missing/,
      );
      // A civic_participation_denied event was appended.
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

    it('rejects a session whose linked civic actor is bound to a different community', async () => {
      const registration = await activatePasskeyAccountAndLinkCommunity({
        app: ctx.app,
        delivery: ctx.delivery,
        email: 'ConfirmationWrongCommunity+setup@example.com',
        communityId: FOUNDATION_COMMUNITY_IDS.munichDe,
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
      const response = await ctx.app.inject({
        method: 'PUT',
        url: `/v1/signals/${FOUNDATION_SIGNAL_IDS.milanoSignal1}/confirmation`,
        headers: { authorization: `Session ${login.sessionToken}` },
        payload: {},
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        error: { code: 'CIVIC_PARTICIPATION_NOT_AUTHORIZED' },
      });
    });

    it('confirms a Milano signal for a participant with an active membership and correct actor', async () => {
      const registration = await activatePasskeyAccountAndLinkCommunity({
        app: ctx.app,
        delivery: ctx.delivery,
        email: 'ConfirmationOk+setup@example.com',
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
      const response = await ctx.app.inject({
        method: 'PUT',
        url: `/v1/signals/${FOUNDATION_SIGNAL_IDS.milanoSignal2}/confirmation`,
        headers: { authorization: `Session ${login.sessionToken}` },
        payload: {},
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<{
        data: { signalId: string; confirmed: boolean; confirmedAt: string };
      }>();
      expect(body.data.confirmed).toBe(true);
      expect(body.data.signalId).toBe(FOUNDATION_SIGNAL_IDS.milanoSignal2);

      // A confirmation row was created for the linked civic actor — not the controlled actor.
      const rows = await ctx.app.database.db
        .select()
        .from(signalConfirmations)
        .where(eq(signalConfirmations.signalId, FOUNDATION_SIGNAL_IDS.milanoSignal2));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.actorId).toBe(registration.actorId);
      expect(rows[0]?.actorId).not.toBe(CONTROLLED_TEST_ACTOR_ID);
    });

    it('is idempotent — PUT twice returns the same confirmedAt and creates only one row', async () => {
      const registration = await activatePasskeyAccountAndLinkCommunity({
        app: ctx.app,
        delivery: ctx.delivery,
        email: 'ConfirmationIdempotent+setup@example.com',
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
      const first = await ctx.app.inject({
        method: 'PUT',
        url: `/v1/signals/${FOUNDATION_SIGNAL_IDS.milanoSignal3}/confirmation`,
        headers: { authorization: `Session ${login.sessionToken}` },
        payload: {},
      });
      const second = await ctx.app.inject({
        method: 'PUT',
        url: `/v1/signals/${FOUNDATION_SIGNAL_IDS.milanoSignal3}/confirmation`,
        headers: { authorization: `Session ${login.sessionToken}` },
        payload: {},
      });
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(second.json()).toEqual(first.json());
      const total = await ctx.app.database.db
        .select({ value: count() })
        .from(signalConfirmations)
        .where(eq(signalConfirmations.signalId, FOUNDATION_SIGNAL_IDS.milanoSignal3));
      expect(total[0]?.value).toBe(1);
    });

    it('never re-assigns confirmation history to the controlled test actor', async () => {
      const controlledActorRows = await ctx.app.database.db
        .select({ value: count() })
        .from(signalConfirmations)
        .where(eq(signalConfirmations.actorId, CONTROLLED_TEST_ACTOR_ID));
      expect(controlledActorRows[0]?.value).toBe(0);
    });

    it('preserves the controlled test actor with account_id = null (never linked)', async () => {
      const row = await ctx.app.database.db
        .select()
        .from(actors)
        .where(eq(actors.id, CONTROLLED_TEST_ACTOR_ID))
        .limit(1);
      expect(row[0]?.accountId).toBeNull();
      expect(row[0]?.kind).toBe('controlled_test');
    });
  });

  describe('with default fail-closed local resolver', () => {
    let ctx: Awaited<ReturnType<typeof createMembershipTestApp>>;

    beforeAll(async () => {
      ctx = await createMembershipTestApp({
        localEligibilityResolver: createDefaultLocalEligibilityResolver({ nodeEnv: 'test' }),
      });
    });

    afterAll(async () => {
      await ctx.app.close();
      await ctx.pool.end();
    });

    it('denies participant confirmation when local eligibility is unavailable', async () => {
      const registration = await activatePasskeyAccountAndLinkCommunity({
        app: ctx.app,
        delivery: ctx.delivery,
        email: 'ConfirmationFailClosed+setup@example.com',
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
      const response = await ctx.app.inject({
        method: 'PUT',
        url: `/v1/signals/${FOUNDATION_SIGNAL_IDS.milanoSignal1}/confirmation`,
        headers: { authorization: `Session ${login.sessionToken}` },
        payload: {},
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        error: { code: 'CIVIC_PARTICIPATION_NOT_AUTHORIZED' },
      });
    });
  });

  describe('GET remains X-TOWN-Control-Key controlled (historical isolation)', () => {
    it('is served by the controlled confirmation test app and still requires the control key', async () => {
      const { createControlledConfirmationTestApp, CONTROLLED_TEST_KEY } =
        await import('./helpers/pg.js');
      const controlled = await createControlledConfirmationTestApp();
      try {
        // GET works with the control key.
        const ok = await controlled.app.inject({
          method: 'GET',
          url: `/v1/signals/${FOUNDATION_SIGNAL_IDS.milanoSignal1}/confirmation`,
          headers: { 'x-town-control-key': CONTROLLED_TEST_KEY },
        });
        expect(ok.statusCode).toBe(200);
        // GET without the control key is rejected.
        const missing = await controlled.app.inject({
          method: 'GET',
          url: `/v1/signals/${FOUNDATION_SIGNAL_IDS.milanoSignal1}/confirmation`,
        });
        expect(missing.statusCode).toBe(401);
      } finally {
        await controlled.app.close();
        await controlled.pool.end();
      }
    });
  });
});

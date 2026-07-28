import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { buildApp, type AppInstance } from '../src/app.js';
import { createInMemoryTestDeliveryAdapter } from '../src/ceremony/email-verification/delivery.js';
import type { Env } from '../src/config/env.js';
import { createDatabase } from '../src/db/client.js';
import { findActiveCommunityBySlug } from '../src/db/repositories/communities.js';
import { accounts, actors } from '../src/db/schema.js';
import { FOUNDATION_COMMUNITY_IDS } from '../src/db/seeds/foundation-content.js';
import { toIsoTimestamp } from '../src/lib/timestamps.js';
import { bindLocalEligibilityInTransaction } from '../src/membership/bind-service.js';
import { MembershipInvariantError } from '../src/membership/errors.js';
import {
  createPasskeyAuthenticationEnv,
  registerActivePasskeyAccount,
} from './helpers/passkey-authentication.js';
import { loginMobileSession } from './helpers/passkey-management.js';
import { requireDatabaseUrl, resetMigrateSeedFoundationAndActor } from './helpers/pg.js';

const FIXED_NOW = '2026-07-23T12:00:00.000Z';
/** Within session idle window (60m) so the same session remains authorized. */
const LATER_NOW = '2026-07-23T12:30:00.000Z';

describe('PUT /v1/account/eligibility', () => {
  let app: AppInstance;
  let pool: Pool;
  let env: Env;
  let delivery: ReturnType<typeof createInMemoryTestDeliveryAdapter>;
  let clock: { now: string };

  beforeAll(async () => {
    const databaseUrl = requireDatabaseUrl();
    pool = new Pool({ connectionString: databaseUrl, max: 1 });
    await resetMigrateSeedFoundationAndActor(pool);

    clock = { now: FIXED_NOW };
    env = createPasskeyAuthenticationEnv({
      LOCAL_ELIGIBILITY_ENABLED: 'true',
    });
    delivery = createInMemoryTestDeliveryAdapter();
    const database = createDatabase({
      connectionString: env.DATABASE_URL,
      poolMax: env.DB_POOL_MAX,
      connectionTimeoutMs: env.DB_CONNECTION_TIMEOUT_MS,
      idleTimeoutMs: env.DB_IDLE_TIMEOUT_MS,
    });

    app = await buildApp({
      env,
      logger: false,
      database,
      emailVerification: { deliveryAdapter: delivery, now: () => clock.now },
      passkeyRegistration: { now: () => clock.now },
      passkeyAuthentication: { now: () => clock.now },
      passkeyManagement: { now: () => clock.now },
      membership: { now: () => clock.now },
    });
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  async function registerAndLogin(email: string) {
    const registration = await registerActivePasskeyAccount(app, delivery, email);
    const login = await loginMobileSession({
      app,
      material: registration.material,
      userHandle: registration.userHandle,
    });
    return { registration, login };
  }

  it('returns 404 when LOCAL_ELIGIBILITY_ENABLED is false', async () => {
    const databaseUrl = requireDatabaseUrl();
    const offPool = new Pool({ connectionString: databaseUrl, max: 1 });
    await resetMigrateSeedFoundationAndActor(offPool);
    const offEnv = createPasskeyAuthenticationEnv({
      LOCAL_ELIGIBILITY_ENABLED: 'false',
    });
    const offDelivery = createInMemoryTestDeliveryAdapter();
    const database = createDatabase({
      connectionString: offEnv.DATABASE_URL,
      poolMax: offEnv.DB_POOL_MAX,
      connectionTimeoutMs: offEnv.DB_CONNECTION_TIMEOUT_MS,
      idleTimeoutMs: offEnv.DB_IDLE_TIMEOUT_MS,
    });
    const offApp = await buildApp({
      env: offEnv,
      logger: false,
      database,
      emailVerification: { deliveryAdapter: offDelivery, now: () => FIXED_NOW },
      passkeyRegistration: { now: () => FIXED_NOW },
      passkeyAuthentication: { now: () => FIXED_NOW },
      membership: { now: () => FIXED_NOW },
    });
    try {
      const registration = await registerActivePasskeyAccount(
        offApp,
        offDelivery,
        'eligibility.flagoff@example.com',
      );
      const login = await loginMobileSession({
        app: offApp,
        material: registration.material,
        userHandle: registration.userHandle,
      });
      const response = await offApp.inject({
        method: 'PUT',
        url: '/v1/account/eligibility',
        headers: { authorization: `Session ${login.sessionToken}` },
        payload: { community: 'milano-it' },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    } finally {
      await offApp.close();
      await offPool.end();
    }
  });

  it('rejects missing session with SESSION_NOT_AUTHORIZED', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/v1/account/eligibility',
      payload: { community: 'milano-it' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'SESSION_NOT_AUTHORIZED' } });
  });

  it('returns 404 COMMUNITY_NOT_FOUND for unknown slug', async () => {
    clock.now = FIXED_NOW;
    const { login } = await registerAndLogin('eligibility.unknown-slug@example.com');
    const response = await app.inject({
      method: 'PUT',
      url: '/v1/account/eligibility',
      headers: { authorization: `Session ${login.sessionToken}` },
      payload: { community: 'no-such-city-xx' },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'COMMUNITY_NOT_FOUND' } });
  });

  it('creates a binding and returns 200 with eligible', async () => {
    clock.now = FIXED_NOW;
    const { login, registration } = await registerAndLogin('eligibility.create@example.com');
    const response = await app.inject({
      method: 'PUT',
      url: '/v1/account/eligibility',
      headers: { authorization: `Session ${login.sessionToken}` },
      payload: { community: 'milano-it' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      data: {
        community: { slug: string; displayName: string };
        verifiedAt: string;
        localEligibility: string;
      };
    }>();
    expect(body.data.community.slug).toBe('milano-it');
    expect(body.data.community.displayName).toBe('Milano');
    expect(body.data.verifiedAt).toBe(FIXED_NOW);
    expect(body.data.localEligibility).toBe('eligible');

    const rows = await app.database.db
      .select()
      .from(actors)
      .where(eq(actors.accountId, registration.accountId))
      .limit(1);
    expect(rows[0]?.communityId).toBe(FOUNDATION_COMMUNITY_IDS.milanoIt);
    expect(toIsoTimestamp(String(rows[0]?.localEligibilityVerifiedAt))).toBe(FIXED_NOW);
  });

  it('is idempotent for the same community and does not refresh verifiedAt', async () => {
    clock.now = FIXED_NOW;
    const { login, registration } = await registerAndLogin('eligibility.idempotent@example.com');
    const first = await app.inject({
      method: 'PUT',
      url: '/v1/account/eligibility',
      headers: { authorization: `Session ${login.sessionToken}` },
      payload: { community: 'munich-de' },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json<{ data: { verifiedAt: string } }>().data.verifiedAt).toBe(FIXED_NOW);

    clock.now = LATER_NOW;
    const second = await app.inject({
      method: 'PUT',
      url: '/v1/account/eligibility',
      headers: { authorization: `Session ${login.sessionToken}` },
      payload: { community: 'munich-de' },
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json<{ data: { verifiedAt: string } }>();
    expect(secondBody.data.verifiedAt).toBe(FIXED_NOW);
    expect(secondBody.data.verifiedAt).not.toBe(LATER_NOW);

    const rows = await app.database.db
      .select()
      .from(actors)
      .where(eq(actors.accountId, registration.accountId))
      .limit(1);
    expect(toIsoTimestamp(String(rows[0]?.localEligibilityVerifiedAt))).toBe(FIXED_NOW);
    expect(rows[0]?.communityId).toBe(FOUNDATION_COMMUNITY_IDS.munichDe);
  });

  it('returns 409 LOCAL_ELIGIBILITY_ALREADY_BOUND for a different community without writing', async () => {
    clock.now = FIXED_NOW;
    const { login, registration } = await registerAndLogin('eligibility.conflict@example.com');
    const first = await app.inject({
      method: 'PUT',
      url: '/v1/account/eligibility',
      headers: { authorization: `Session ${login.sessionToken}` },
      payload: { community: 'arad-ro' },
    });
    expect(first.statusCode).toBe(200);

    const before = await app.database.db
      .select()
      .from(actors)
      .where(eq(actors.accountId, registration.accountId))
      .limit(1);

    const second = await app.inject({
      method: 'PUT',
      url: '/v1/account/eligibility',
      headers: { authorization: `Session ${login.sessionToken}` },
      payload: { community: 'milano-it' },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({
      error: { code: 'LOCAL_ELIGIBILITY_ALREADY_BOUND' },
    });

    const after = await app.database.db
      .select()
      .from(actors)
      .where(eq(actors.accountId, registration.accountId))
      .limit(1);
    expect(after[0]?.communityId).toBe(before[0]?.communityId);
    expect(after[0]?.localEligibilityVerifiedAt).toBe(before[0]?.localEligibilityVerifiedAt);
    expect(after[0]?.updatedAt).toBe(before[0]?.updatedAt);
  });

  it('allows an is_owner account to re-bind to a different community and refreshes verifiedAt', async () => {
    clock.now = FIXED_NOW;
    const { login, registration } = await registerAndLogin('eligibility.owner-rebind@example.com');
    await app.database.db
      .update(accounts)
      .set({ isOwner: true })
      .where(eq(accounts.id, registration.accountId));

    const first = await app.inject({
      method: 'PUT',
      url: '/v1/account/eligibility',
      headers: { authorization: `Session ${login.sessionToken}` },
      payload: { community: 'arad-ro' },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json<{ data: { verifiedAt: string } }>().data.verifiedAt).toBe(FIXED_NOW);

    clock.now = LATER_NOW;
    const second = await app.inject({
      method: 'PUT',
      url: '/v1/account/eligibility',
      headers: { authorization: `Session ${login.sessionToken}` },
      payload: { community: 'milano-it' },
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json<{
      data: {
        community: { slug: string; displayName: string };
        verifiedAt: string;
        localEligibility: string;
      };
    }>();
    expect(secondBody.data.community.slug).toBe('milano-it');
    expect(secondBody.data.community.displayName).toBe('Milano');
    expect(secondBody.data.verifiedAt).toBe(LATER_NOW);
    expect(secondBody.data.localEligibility).toBe('eligible');

    const rows = await app.database.db
      .select()
      .from(actors)
      .where(eq(actors.accountId, registration.accountId))
      .limit(1);
    expect(rows[0]?.communityId).toBe(FOUNDATION_COMMUNITY_IDS.milanoIt);
    expect(toIsoTimestamp(String(rows[0]?.localEligibilityVerifiedAt))).toBe(LATER_NOW);
  });

  it('keeps same-community bind idempotent for an is_owner account (no verifiedAt refresh)', async () => {
    clock.now = FIXED_NOW;
    const { login, registration } = await registerAndLogin(
      'eligibility.owner-idempotent@example.com',
    );
    await app.database.db
      .update(accounts)
      .set({ isOwner: true })
      .where(eq(accounts.id, registration.accountId));

    const first = await app.inject({
      method: 'PUT',
      url: '/v1/account/eligibility',
      headers: { authorization: `Session ${login.sessionToken}` },
      payload: { community: 'munich-de' },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json<{ data: { verifiedAt: string } }>().data.verifiedAt).toBe(FIXED_NOW);

    clock.now = LATER_NOW;
    const second = await app.inject({
      method: 'PUT',
      url: '/v1/account/eligibility',
      headers: { authorization: `Session ${login.sessionToken}` },
      payload: { community: 'munich-de' },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json<{ data: { verifiedAt: string } }>().data.verifiedAt).toBe(FIXED_NOW);
    expect(second.json<{ data: { verifiedAt: string } }>().data.verifiedAt).not.toBe(LATER_NOW);

    const rows = await app.database.db
      .select()
      .from(actors)
      .where(eq(actors.accountId, registration.accountId))
      .limit(1);
    expect(rows[0]?.communityId).toBe(FOUNDATION_COMMUNITY_IDS.munichDe);
    expect(toIsoTimestamp(String(rows[0]?.localEligibilityVerifiedAt))).toBe(FIXED_NOW);
  });

  it('creates a first-time binding for an is_owner account the same as a non-owner', async () => {
    clock.now = FIXED_NOW;
    const { login, registration } = await registerAndLogin(
      'eligibility.owner-first-bind@example.com',
    );
    await app.database.db
      .update(accounts)
      .set({ isOwner: true })
      .where(eq(accounts.id, registration.accountId));

    const response = await app.inject({
      method: 'PUT',
      url: '/v1/account/eligibility',
      headers: { authorization: `Session ${login.sessionToken}` },
      payload: { community: 'milano-it' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      data: {
        community: { slug: string };
        verifiedAt: string;
        localEligibility: string;
      };
    }>();
    expect(body.data.community.slug).toBe('milano-it');
    expect(body.data.verifiedAt).toBe(FIXED_NOW);
    expect(body.data.localEligibility).toBe('eligible');

    const rows = await app.database.db
      .select()
      .from(actors)
      .where(eq(actors.accountId, registration.accountId))
      .limit(1);
    expect(rows[0]?.communityId).toBe(FOUNDATION_COMMUNITY_IDS.milanoIt);
    expect(toIsoTimestamp(String(rows[0]?.localEligibilityVerifiedAt))).toBe(FIXED_NOW);
  });

  it('returns 500 INTERNAL_ERROR when the authenticated account has no linked civic actor', async () => {
    clock.now = FIXED_NOW;
    const { login, registration } = await registerAndLogin('eligibility.no-actor@example.com');
    await app.database.db
      .update(actors)
      .set({ accountId: null })
      .where(eq(actors.accountId, registration.accountId));

    const response = await app.inject({
      method: 'PUT',
      url: '/v1/account/eligibility',
      headers: { authorization: `Session ${login.sessionToken}` },
      payload: { community: 'milano-it' },
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
  });

  function assertInternalErrorEnvelope(response: {
    statusCode: number;
    json: () => unknown;
  }): void {
    expect(response.statusCode).toBe(500);
    const body = response.json() as {
      error: { code: string; message: string; requestId: string };
    };
    expect(Object.keys(body).sort()).toEqual(['error']);
    expect(Object.keys(body.error).sort()).toEqual(['code', 'message', 'requestId']);
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toBe('An unexpected error occurred.');
    expect(typeof body.error.requestId).toBe('string');
    expect(body.error.requestId.length).toBeGreaterThan(0);
  }

  it('throws the bounded ACCOUNT_NOT_FOUND invariant error when the account row is absent', async () => {
    const community = await findActiveCommunityBySlug(app.database.db, 'milano-it');
    expect(community).not.toBeNull();
    if (!community) {
      throw new Error('Foundation community milano-it must be seeded');
    }

    await expect(
      app.database.db.transaction(async (tx) =>
        bindLocalEligibilityInTransaction(tx, {
          accountId: '11000000-0000-4000-8000-00000000dead',
          community,
          now: FIXED_NOW,
        }),
      ),
    ).rejects.toMatchObject({
      name: 'MembershipInvariantError',
      code: 'ACCOUNT_NOT_FOUND',
    });
  });

  it('returns the declared 500 INTERNAL_ERROR envelope when the linked civic actor is missing', async () => {
    clock.now = FIXED_NOW;
    const { login, registration } = await registerAndLogin(
      'eligibility.no-actor-envelope@example.com',
    );
    await app.database.db
      .update(actors)
      .set({ accountId: null })
      .where(eq(actors.accountId, registration.accountId));

    const response = await app.inject({
      method: 'PUT',
      url: '/v1/account/eligibility',
      headers: { authorization: `Session ${login.sessionToken}` },
      payload: { community: 'milano-it' },
    });
    assertInternalErrorEnvelope(response);
  });

  it('throws the bounded LOCAL_ELIGIBILITY_PERSIST_FAILED invariant error when the persisted verified_at reads back null', async () => {
    const community = await findActiveCommunityBySlug(app.database.db, 'milano-it');
    expect(community).not.toBeNull();
    if (!community) {
      throw new Error('Foundation community milano-it must be seeded');
    }

    // Deterministic stand-in transaction handle passed through the existing
    // `db` parameter seam of bindLocalEligibilityInTransaction. The real
    // database cannot produce this state: the UPDATE ... RETURNING reflects
    // the non-null verified_at it just set, so the defensive branch is only
    // reachable when the returned row reads back null.
    const actorRow = {
      id: '11000000-0000-4000-8000-00000000ac10',
      communityId: null,
      localEligibilityVerifiedAt: null,
    };
    function createThenableChain(rows: unknown[]): Record<string, unknown> {
      const chain: Record<string, unknown> = {};
      const returnSelf = () => chain;
      for (const method of ['from', 'where', 'limit', 'for', 'set', 'returning']) {
        chain[method] = returnSelf;
      }
      chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve);
      return chain;
    }
    const selectResults: unknown[][] = [
      [{ id: '11000000-0000-4000-8000-00000000acc7', isOwner: false }],
      [actorRow],
    ];
    const fakeTx = {
      select: () => createThenableChain(selectResults.shift() ?? []),
      update: () =>
        createThenableChain([
          { ...actorRow, communityId: community.id, localEligibilityVerifiedAt: null },
        ]),
    } as unknown as Parameters<typeof bindLocalEligibilityInTransaction>[0];

    const error = await bindLocalEligibilityInTransaction(fakeTx, {
      accountId: '11000000-0000-4000-8000-00000000acc7',
      community,
      now: FIXED_NOW,
    }).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(MembershipInvariantError);
    expect((error as MembershipInvariantError).code).toBe('LOCAL_ELIGIBILITY_PERSIST_FAILED');
  });

  it('returns the declared 500 INTERNAL_ERROR envelope when an existing binding is missing verified_at', async () => {
    clock.now = FIXED_NOW;
    const { login, registration } = await registerAndLogin(
      'eligibility.binding-missing-verified-at@example.com',
    );
    await app.database.db
      .update(actors)
      .set({ communityId: FOUNDATION_COMMUNITY_IDS.milanoIt, localEligibilityVerifiedAt: null })
      .where(eq(actors.accountId, registration.accountId));

    const response = await app.inject({
      method: 'PUT',
      url: '/v1/account/eligibility',
      headers: { authorization: `Session ${login.sessionToken}` },
      payload: { community: 'milano-it' },
    });
    assertInternalErrorEnvelope(response);
  });
});

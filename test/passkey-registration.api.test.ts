import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, count, eq, isNull } from 'drizzle-orm';
import type { AppInstance } from '../src/app.js';
import {
  accountSessions,
  accounts,
  actors,
  identitySecurityEvents,
  passkeyCredentials,
  setupGrants,
  signalConfirmations,
  webauthnChallenges,
} from '../src/db/schema.js';
import { CONTROLLED_TEST_ACTOR_ID } from '../src/db/seeds/controlled-actor-content.js';
import { toIsoTimestamp } from '../src/lib/timestamps.js';
import { createSoftRegistrationResponse } from './helpers/webauthn-soft-authenticator.js';
import {
  completeEmailSetup,
  createPasskeyRegistrationTestApp,
  TEST_ORIGIN,
  TEST_RP_ID,
} from './helpers/passkey-registration.js';

const FIXED_NOW = '2026-07-16T14:00:00.000Z';
const FAILURE_BODY = {
  error: {
    code: 'PASSKEY_REGISTRATION_FAILED',
    message: 'Passkey registration could not be completed.',
  },
};

type OptionsJson = {
  data: {
    registrationCeremonyId: string;
    options: {
      challenge: string;
      rp: { id: string; name: string };
      user: { id: string; name: string; displayName: string };
      pubKeyCredParams: { alg: number; type: string }[];
      authenticatorSelection: {
        residentKey: string;
        requireResidentKey: boolean;
        userVerification: string;
      };
      attestation: string;
      timeout: number;
      excludeCredentials: unknown[];
    };
  };
};

describe('passkey registration runtime API', () => {
  let app: AppInstance | undefined;
  let pool: Awaited<ReturnType<typeof createPasskeyRegistrationTestApp>>['pool'] | undefined;
  let delivery:
    Awaited<ReturnType<typeof createPasskeyRegistrationTestApp>>['delivery'] | undefined;

  async function boot(options?: Parameters<typeof createPasskeyRegistrationTestApp>[0]) {
    if (app !== undefined) {
      await app.close();
    }
    if (pool !== undefined) {
      await pool.end();
    }
    const created = await createPasskeyRegistrationTestApp({
      now: () => FIXED_NOW,
      ...options,
    });
    app = created.app;
    pool = created.pool;
    delivery = created.delivery;
    return created;
  }

  beforeEach(async () => {
    await boot();
  });

  afterAll(async () => {
    if (app !== undefined) {
      await app.close();
    }
    if (pool !== undefined) {
      await pool.end();
    }
  });

  function currentApp(): AppInstance {
    if (app === undefined) {
      throw new Error('app not ready');
    }
    return app;
  }

  function currentPool(): NonNullable<typeof pool> {
    if (pool === undefined) {
      throw new Error('pool not ready');
    }
    return pool;
  }

  function currentDelivery(): NonNullable<typeof delivery> {
    if (delivery === undefined) {
      throw new Error('delivery not ready');
    }
    return delivery;
  }

  async function createSetup(email = 'Passkey.User+setup@example.com') {
    return await completeEmailSetup(currentApp(), currentDelivery(), email);
  }

  async function requestOptions(setupGrant: string) {
    return await currentApp().inject({
      method: 'POST',
      url: '/v1/account/passkeys/registration/options',
      headers: { authorization: `SetupGrant ${setupGrant}` },
      payload: {},
    });
  }

  async function startCeremony(email?: string) {
    const setup = await createSetup(email);
    const optionsResponse = await requestOptions(setup.setupGrant);
    expect(optionsResponse.statusCode).toBe(200);
    return {
      ...setup,
      body: optionsResponse.json<OptionsJson>(),
    };
  }

  async function verifyCeremony(input: {
    setupGrant: string;
    registrationCeremonyId: string;
    challenge: string;
    origin?: string;
    rpID?: string;
    userVerified?: boolean;
  }) {
    const response = createSoftRegistrationResponse({
      challenge: input.challenge,
      rpID: input.rpID ?? TEST_RP_ID,
      origin: input.origin ?? TEST_ORIGIN,
      userVerified: input.userVerified ?? true,
    });
    return await currentApp().inject({
      method: 'POST',
      url: '/v1/account/passkeys/registration/verify',
      headers: { authorization: `SetupGrant ${input.setupGrant}` },
      payload: {
        registrationCeremonyId: input.registrationCeremonyId,
        response,
      },
    });
  }

  async function countPasskeys() {
    return (await currentApp().database.db.select({ value: count() }).from(passkeyCredentials))[0]
      ?.value;
  }

  async function countSessions() {
    return (await currentApp().database.db.select({ value: count() }).from(accountSessions))[0]
      ?.value;
  }

  async function countSecurityEvent(eventType: string) {
    return (
      await currentApp()
        .database.db.select({ value: count() })
        .from(identitySecurityEvents)
        .where(eq(identitySecurityEvents.eventType, eventType))
    )[0]?.value;
  }

  async function expectNoActivation(accountId: string) {
    const account = (
      await currentApp().database.db.select().from(accounts).where(eq(accounts.id, accountId))
    )[0];
    expect(account?.status).toBe('pending_passkey');
    expect(await countPasskeys()).toBe(0);
    expect(
      (
        await currentApp()
          .database.db.select({ value: count() })
          .from(actors)
          .where(eq(actors.accountId, accountId))
      )[0]?.value,
    ).toBe(0);
  }

  it('defaults disabled feature to safe not-found', async () => {
    await boot({ enabled: false });
    const response = await currentApp().inject({
      method: 'POST',
      url: '/v1/account/passkeys/registration/options',
      headers: { authorization: 'SetupGrant test-token' },
      payload: {},
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      statusCode: 404,
      error: 'Not Found',
      message: 'Not Found',
    });
  });

  it('returns generic failure for missing or malformed SetupGrant authorization', async () => {
    const missing = await currentApp().inject({
      method: 'POST',
      url: '/v1/account/passkeys/registration/options',
      payload: {},
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject(FAILURE_BODY);

    const malformed = await currentApp().inject({
      method: 'POST',
      url: '/v1/account/passkeys/registration/options',
      headers: { authorization: 'Bearer not-a-setup-grant' },
      payload: {},
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject(FAILURE_BODY);
  });

  it('creates WebAuthn registration options with the required policy', async () => {
    const { setupGrant } = await createSetup();
    const response = await requestOptions(setupGrant);
    expect(response.statusCode).toBe(200);
    const body = response.json<OptionsJson>();

    expect(body.data.registrationCeremonyId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(body.data.options.rp).toEqual({ id: TEST_RP_ID, name: 'TOWN' });
    expect(body.data.options.authenticatorSelection).toEqual({
      residentKey: 'required',
      requireResidentKey: true,
      userVerification: 'required',
    });
    expect(body.data.options.attestation).toBe('none');
    expect(body.data.options.pubKeyCredParams).toEqual([
      { alg: -7, type: 'public-key' },
      { alg: -257, type: 'public-key' },
    ]);
    expect(body.data.options.user.id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(body.data.options.user.id, 'base64url')).toHaveLength(32);
    expect(body.data.options.user.id).not.toContain('@');
  });

  it('keeps the opaque user handle stable across options retries', async () => {
    const { setupGrant } = await createSetup('Stable.Handle+passkey@example.com');
    const first = (await requestOptions(setupGrant)).json<OptionsJson>();
    const second = (await requestOptions(setupGrant)).json<OptionsJson>();

    expect(first.data.options.user.id).toBe(second.data.options.user.id);
  });

  it('revokes prior registration challenges when creating new options', async () => {
    const { accountId, setupGrant } = await createSetup('Revoke.Prior+passkey@example.com');
    const first = (await requestOptions(setupGrant)).json<OptionsJson>();
    const second = (await requestOptions(setupGrant)).json<OptionsJson>();

    const challenges = await currentApp().database.db.select().from(webauthnChallenges);
    expect(challenges).toHaveLength(2);
    expect(
      challenges.find((row) => row.id === first.data.registrationCeremonyId)?.revokedAt,
    ).not.toBeNull();
    expect(
      challenges.find((row) => row.id === second.data.registrationCeremonyId)?.revokedAt,
    ).toBeNull();
    expect(
      (
        await currentApp()
          .database.db.select({ value: count() })
          .from(webauthnChallenges)
          .where(
            and(
              eq(webauthnChallenges.accountId, accountId),
              eq(webauthnChallenges.purpose, 'register'),
              isNull(webauthnChallenges.consumedAt),
              isNull(webauthnChallenges.revokedAt),
            ),
          )
      )[0]?.value,
    ).toBe(1);
  });

  it('rate limits options after five attempts with the generic failure', async () => {
    const { setupGrant } = await createSetup('Rate.Limit+passkey@example.com');
    for (let index = 0; index < 5; index += 1) {
      expect((await requestOptions(setupGrant)).statusCode).toBe(200);
    }

    const limited = await requestOptions(setupGrant);
    expect(limited.statusCode).toBe(400);
    expect(limited.json()).toMatchObject(FAILURE_BODY);
  });

  it('verifies a valid soft authenticator registration and activates the account', async () => {
    const ceremony = await startCeremony('Ready.User+passkey@example.com');
    const verify = await verifyCeremony({
      setupGrant: ceremony.setupGrant,
      registrationCeremonyId: ceremony.body.data.registrationCeremonyId,
      challenge: ceremony.body.data.options.challenge,
    });
    expect(verify.statusCode).toBe(200);
    expect(verify.json()).toEqual({ data: { status: 'ACCOUNT_READY' } });

    const db = currentApp().database.db;
    const credential = (await db.select().from(passkeyCredentials))[0];
    expect(credential).toBeDefined();
    expect(credential?.accountId).toBe(ceremony.accountId);
    expect(credential?.credentialId.length).toBeGreaterThan(0);
    expect(credential?.publicKey.length).toBeGreaterThan(0);
    expect(credential?.signCount).toBe(0);

    const civicActor = (
      await db.select().from(actors).where(eq(actors.accountId, ceremony.accountId))
    )[0];
    expect(civicActor?.kind).toBe('civic');
    expect(civicActor?.communityId).toBeNull();

    const account = (
      await db.select().from(accounts).where(eq(accounts.id, ceremony.accountId))
    )[0];
    expect(account?.status).toBe('active');
    expect(account?.accountReadyAt ? toIsoTimestamp(account.accountReadyAt) : null).toBe(FIXED_NOW);
    expect(account?.webauthnUserHandle).not.toBeNull();

    const setupGrant = (
      await db.select().from(setupGrants).where(eq(setupGrants.accountId, ceremony.accountId))
    )[0];
    expect(setupGrant?.consumedAt ? toIsoTimestamp(setupGrant.consumedAt) : null).toBe(FIXED_NOW);
    expect(setupGrant?.revokedAt).toBeNull();

    const challenge = (
      await db
        .select()
        .from(webauthnChallenges)
        .where(eq(webauthnChallenges.id, ceremony.body.data.registrationCeremonyId))
    )[0];
    expect(challenge?.consumedAt ? toIsoTimestamp(challenge.consumedAt) : null).toBe(FIXED_NOW);
    expect(challenge?.revokedAt).toBeNull();

    expect(await countSecurityEvent('passkey_registered')).toBe(1);
    expect(await countSecurityEvent('account_activated')).toBe(1);
    expect(await countSessions()).toBe(0);
    expect(
      (await db.select().from(actors).where(eq(actors.id, CONTROLLED_TEST_ACTOR_ID)))[0]?.accountId,
    ).toBeNull();
    expect((await db.select({ value: count() }).from(signalConfirmations))[0]?.value).toBe(0);
  });

  it('rejects wrong origin without activating the account', async () => {
    const ceremony = await startCeremony('Wrong.Origin+passkey@example.com');
    const response = await verifyCeremony({
      setupGrant: ceremony.setupGrant,
      registrationCeremonyId: ceremony.body.data.registrationCeremonyId,
      challenge: ceremony.body.data.options.challenge,
      origin: 'http://localhost:4000',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject(FAILURE_BODY);
    await expectNoActivation(ceremony.accountId);
  });

  it('rejects wrong RP ID without activating the account', async () => {
    const ceremony = await startCeremony('Wrong.Rp+passkey@example.com');
    const response = await verifyCeremony({
      setupGrant: ceremony.setupGrant,
      registrationCeremonyId: ceremony.body.data.registrationCeremonyId,
      challenge: ceremony.body.data.options.challenge,
      rpID: 'example.com',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject(FAILURE_BODY);
    await expectNoActivation(ceremony.accountId);
  });

  it('rejects missing user verification', async () => {
    const ceremony = await startCeremony('No.Uv+passkey@example.com');
    const response = await verifyCeremony({
      setupGrant: ceremony.setupGrant,
      registrationCeremonyId: ceremony.body.data.registrationCeremonyId,
      challenge: ceremony.body.data.options.challenge,
      userVerified: false,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject(FAILURE_BODY);
    await expectNoActivation(ceremony.accountId);
  });

  it('rejects replayed verify without duplicating credential or actor state', async () => {
    const ceremony = await startCeremony('Replay.Verify+passkey@example.com');
    const payload = {
      registrationCeremonyId: ceremony.body.data.registrationCeremonyId,
      response: createSoftRegistrationResponse({
        challenge: ceremony.body.data.options.challenge,
        rpID: TEST_RP_ID,
        origin: TEST_ORIGIN,
      }),
    };
    const first = await currentApp().inject({
      method: 'POST',
      url: '/v1/account/passkeys/registration/verify',
      headers: { authorization: `SetupGrant ${ceremony.setupGrant}` },
      payload,
    });
    const replay = await currentApp().inject({
      method: 'POST',
      url: '/v1/account/passkeys/registration/verify',
      headers: { authorization: `SetupGrant ${ceremony.setupGrant}` },
      payload,
    });

    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(400);
    expect(replay.json()).toMatchObject(FAILURE_BODY);
    expect(await countPasskeys()).toBe(1);
    expect(
      (
        await currentApp()
          .database.db.select({ value: count() })
          .from(actors)
          .where(eq(actors.accountId, ceremony.accountId))
      )[0]?.value,
    ).toBe(1);
  });

  it('allows exactly one concurrent successful verify for the same ceremony', async () => {
    const ceremony = await startCeremony('Concurrent.Verify+passkey@example.com');
    const payload = {
      registrationCeremonyId: ceremony.body.data.registrationCeremonyId,
      response: createSoftRegistrationResponse({
        challenge: ceremony.body.data.options.challenge,
        rpID: TEST_RP_ID,
        origin: TEST_ORIGIN,
      }),
    };

    const results = await Promise.all(
      [0, 1].map(() =>
        currentApp().inject({
          method: 'POST',
          url: '/v1/account/passkeys/registration/verify',
          headers: { authorization: `SetupGrant ${ceremony.setupGrant}` },
          payload,
        }),
      ),
    );

    expect(results.filter((response) => response.statusCode === 200)).toHaveLength(1);
    expect(results.filter((response) => response.statusCode === 400)).toHaveLength(1);
    expect(await countPasskeys()).toBe(1);
    expect(
      (
        await currentApp()
          .database.db.select({ value: count() })
          .from(actors)
          .where(eq(actors.accountId, ceremony.accountId))
      )[0]?.value,
    ).toBe(1);
  });

  it('rejects expired, consumed, revoked, and wrong-purpose setup grants without state leak', async () => {
    const cases: {
      name: string;
      mutate: (accountId: string) => Promise<void>;
    }[] = [
      {
        name: 'expired',
        mutate: async (accountId) => {
          await currentApp()
            .database.db.update(setupGrants)
            .set({
              createdAt: '2026-07-16T13:00:00.000Z',
              expiresAt: '2026-07-16T13:59:59.000Z',
            })
            .where(eq(setupGrants.accountId, accountId));
        },
      },
      {
        name: 'consumed',
        mutate: async (accountId) => {
          await currentApp()
            .database.db.update(setupGrants)
            .set({ consumedAt: FIXED_NOW })
            .where(eq(setupGrants.accountId, accountId));
        },
      },
      {
        name: 'revoked',
        mutate: async (accountId) => {
          await currentApp()
            .database.db.update(setupGrants)
            .set({ revokedAt: FIXED_NOW })
            .where(eq(setupGrants.accountId, accountId));
        },
      },
      {
        name: 'wrong purpose',
        mutate: async (accountId) => {
          await currentPool().query(
            'ALTER TABLE town.setup_grants DROP CONSTRAINT setup_grants_purpose_valid',
          );
          await currentPool().query(
            'UPDATE town.setup_grants SET purpose = $1 WHERE account_id = $2',
            ['recover_account', accountId],
          );
        },
      },
    ];

    for (const testCase of cases) {
      await boot();
      const emailSlug = testCase.name.replace(/\s+/g, '.');
      const { accountId, setupGrant } = await createSetup(`Grant.${emailSlug}@example.com`);
      await testCase.mutate(accountId);

      const response = await requestOptions(setupGrant);
      expect(response.statusCode, testCase.name).toBe(400);
      expect(response.json(), testCase.name).toMatchObject(FAILURE_BODY);
      await expectNoActivation(accountId);
      expect(
        (
          await currentApp()
            .database.db.select({ value: count() })
            .from(webauthnChallenges)
            .where(eq(webauthnChallenges.accountId, accountId))
        )[0]?.value,
        testCase.name,
      ).toBe(0);
    }
  });

  it('rejects options when the setup grant account is already active', async () => {
    const { accountId, setupGrant } = await createSetup('Already.Active+passkey@example.com');
    await currentApp()
      .database.db.update(accounts)
      .set({
        status: 'active',
        webauthnUserHandle: Buffer.alloc(32, 7),
        accountReadyAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      })
      .where(eq(accounts.id, accountId));

    const response = await requestOptions(setupGrant);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject(FAILURE_BODY);
    expect(await countPasskeys()).toBe(0);
  });
});

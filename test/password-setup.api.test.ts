import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, count, eq, isNull } from 'drizzle-orm';
import type { AppInstance } from '../src/app.js';
import { hashOpaqueToken } from '../src/ceremony/email-verification/crypto.js';
import {
  accountPasswordCredentials,
  accountSessions,
  accounts,
  identitySecurityEvents,
  setupGrants,
} from '../src/db/schema.js';
import { toIsoTimestamp } from '../src/lib/timestamps.js';
import {
  completeEmailSetup,
  createPasskeyRegistrationTestApp,
  TEST_EMAIL_VERIFICATION_HASH_KEY,
  TEST_INITIAL_PASSWORD,
} from './helpers/passkey-registration.js';

const FIXED_NOW = '2026-07-16T14:00:00.000Z';
const FAILURE_BODY = {
  error: {
    code: 'PASSWORD_SETUP_FAILED',
    message: 'Password setup could not be completed.',
  },
};

describe('initial password setup API', () => {
  let app: AppInstance | undefined;
  let pool: Awaited<ReturnType<typeof createPasskeyRegistrationTestApp>>['pool'] | undefined;
  let delivery:
    Awaited<ReturnType<typeof createPasskeyRegistrationTestApp>>['delivery'] | undefined;

  async function boot(options?: { passwordEnabled?: boolean; now?: () => string }): Promise<void> {
    if (app !== undefined) {
      await app.close();
      app = undefined;
    }
    if (pool !== undefined) {
      await pool.end();
      pool = undefined;
    }
    const created = await createPasskeyRegistrationTestApp({
      passwordEnabled: options?.passwordEnabled ?? true,
      now: options?.now ?? (() => FIXED_NOW),
    });
    app = created.app;
    pool = created.pool;
    delivery = created.delivery;
  }

  function currentApp(): AppInstance {
    if (app === undefined) {
      throw new Error('app not initialized');
    }
    return app;
  }

  function currentDelivery(): NonNullable<typeof delivery> {
    if (delivery === undefined) {
      throw new Error('delivery not initialized');
    }
    return delivery;
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

  it('returns 404 when PASSWORD_AUTH_ENABLED is false', async () => {
    await boot({ passwordEnabled: false });
    const response = await currentApp().inject({
      method: 'POST',
      url: '/v1/account/password',
      headers: { authorization: 'SetupGrant unused' },
      payload: { password: TEST_INITIAL_PASSWORD },
    });
    expect(response.statusCode).toBe(404);
  });

  it('completes password setup, hands off a passkey grant, and creates no session', async () => {
    const emailSetup = await completeEmailSetup(
      currentApp(),
      currentDelivery(),
      'Password.Setup+ok@example.com',
    );
    expect((await currentApp().database.db.select().from(accounts))[0]?.status).toBe(
      'pending_password',
    );

    const response = await currentApp().inject({
      method: 'POST',
      url: '/v1/account/password',
      headers: { authorization: `SetupGrant ${emailSetup.setupGrant}` },
      payload: { password: TEST_INITIAL_PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      data: { status: string; setupGrant: string; setupGrantExpiresAt: string };
    }>();
    expect(body.data.status).toBe('PASSWORD_SET');
    expect(body.data.setupGrant).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(body.data.setupGrantExpiresAt).toBe(
      toIsoTimestamp(new Date(Date.parse(FIXED_NOW) + 15 * 60_000).toISOString()),
    );
    expect(JSON.stringify(body)).not.toContain(TEST_INITIAL_PASSWORD);
    expect(JSON.stringify(body)).not.toMatch(/\$argon2id\$/);

    const db = currentApp().database.db;
    const account = (
      await db.select().from(accounts).where(eq(accounts.id, emailSetup.accountId))
    )[0];
    expect(account?.status).toBe('pending_passkey');

    const credentials = await db.select().from(accountPasswordCredentials);
    expect(credentials).toHaveLength(1);
    expect(credentials[0]?.accountId).toBe(emailSetup.accountId);
    expect(credentials[0]?.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(credentials[0]?.revokedAt).toBeNull();

    const grants = await db.select().from(setupGrants);
    const passwordGrants = grants.filter((row) => row.purpose === 'initial_password_setup');
    const passkeyGrants = grants.filter((row) => row.purpose === 'initial_passkey_registration');
    expect(passwordGrants.some((row) => row.consumedAt != null)).toBe(true);
    expect(
      passkeyGrants.filter((row) => row.revokedAt == null && row.consumedAt == null),
    ).toHaveLength(1);

    expect((await db.select({ value: count() }).from(accountSessions))[0]?.value).toBe(0);
    const events = await db
      .select()
      .from(identitySecurityEvents)
      .where(eq(identitySecurityEvents.eventType, 'password_credential_created'));
    expect(events).toHaveLength(1);

    const replay = await currentApp().inject({
      method: 'POST',
      url: '/v1/account/password',
      headers: { authorization: `SetupGrant ${emailSetup.setupGrant}` },
      payload: { password: TEST_INITIAL_PASSWORD },
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.json()).toMatchObject(FAILURE_BODY);
  });

  it('rejects missing auth, wrong-purpose grants, and policy violations with a bounded error', async () => {
    const emailSetup = await completeEmailSetup(
      currentApp(),
      currentDelivery(),
      'Password.Fail+ok@example.com',
    );

    const missing = await currentApp().inject({
      method: 'POST',
      url: '/v1/account/password',
      payload: { password: TEST_INITIAL_PASSWORD },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject(FAILURE_BODY);

    const short = await currentApp().inject({
      method: 'POST',
      url: '/v1/account/password',
      headers: { authorization: `SetupGrant ${emailSetup.setupGrant}` },
      payload: { password: 'too-short' },
    });
    expect(short.statusCode).toBe(400);
    expect(short.json()).toMatchObject(FAILURE_BODY);
    expect(JSON.stringify(short.json())).not.toContain('too-short');

    // Consume password grant via success, then attempt with a passkey-purpose grant.
    const success = await currentApp().inject({
      method: 'POST',
      url: '/v1/account/password',
      headers: { authorization: `SetupGrant ${emailSetup.setupGrant}` },
      payload: { password: TEST_INITIAL_PASSWORD },
    });
    expect(success.statusCode).toBe(200);
    const passkeyGrant = success.json<{ data: { setupGrant: string } }>().data.setupGrant;

    const wrongPurpose = await currentApp().inject({
      method: 'POST',
      url: '/v1/account/password',
      headers: { authorization: `SetupGrant ${passkeyGrant}` },
      payload: { password: TEST_INITIAL_PASSWORD },
    });
    expect(wrongPurpose.statusCode).toBe(400);
    expect(wrongPurpose.json()).toMatchObject(FAILURE_BODY);
  });

  async function assertNoPasswordSetupSideEffects(accountId: string): Promise<void> {
    const db = currentApp().database.db;
    expect(
      (
        await db
          .select({ value: count() })
          .from(accountPasswordCredentials)
          .where(eq(accountPasswordCredentials.accountId, accountId))
      )[0]?.value,
    ).toBe(0);
    expect((await db.select().from(accounts).where(eq(accounts.id, accountId)))[0]?.status).toBe(
      'pending_password',
    );
    expect(
      (
        await db
          .select({ value: count() })
          .from(setupGrants)
          .where(
            and(
              eq(setupGrants.accountId, accountId),
              eq(setupGrants.purpose, 'initial_passkey_registration'),
            ),
          )
      )[0]?.value,
    ).toBe(0);
    expect((await db.select({ value: count() }).from(accountSessions))[0]?.value).toBe(0);
  }

  it('allows exactly one concurrent successful password setup for the same grant', async () => {
    const emailSetup = await completeEmailSetup(
      currentApp(),
      currentDelivery(),
      'Password.Concurrent+ok@example.com',
    );

    const results = await Promise.all(
      [0, 1].map(() =>
        currentApp().inject({
          method: 'POST',
          url: '/v1/account/password',
          headers: { authorization: `SetupGrant ${emailSetup.setupGrant}` },
          payload: { password: TEST_INITIAL_PASSWORD },
        }),
      ),
    );

    expect(results.filter((response) => response.statusCode === 200)).toHaveLength(1);
    expect(results.filter((response) => response.statusCode === 400)).toHaveLength(1);
    for (const failed of results.filter((response) => response.statusCode === 400)) {
      expect(failed.json()).toMatchObject(FAILURE_BODY);
    }

    const successBodies = results
      .filter((response) => response.statusCode === 200)
      .map(
        (response) =>
          response.json<{ data: { status: string; setupGrant: string } }>().data.setupGrant,
      );
    expect(successBodies).toHaveLength(1);

    const db = currentApp().database.db;
    const activeCredentials = await db
      .select()
      .from(accountPasswordCredentials)
      .where(
        and(
          eq(accountPasswordCredentials.accountId, emailSetup.accountId),
          isNull(accountPasswordCredentials.revokedAt),
        ),
      );
    expect(activeCredentials).toHaveLength(1);

    expect(
      (await db.select().from(accounts).where(eq(accounts.id, emailSetup.accountId)))[0]?.status,
    ).toBe('pending_passkey');

    const usablePasskeyGrants = await db
      .select()
      .from(setupGrants)
      .where(
        and(
          eq(setupGrants.accountId, emailSetup.accountId),
          eq(setupGrants.purpose, 'initial_passkey_registration'),
          isNull(setupGrants.consumedAt),
          isNull(setupGrants.revokedAt),
        ),
      );
    expect(usablePasskeyGrants).toHaveLength(1);
    expect((await db.select({ value: count() }).from(accountSessions))[0]?.value).toBe(0);

    const createdEvents = await db
      .select()
      .from(identitySecurityEvents)
      .where(
        and(
          eq(identitySecurityEvents.accountId, emailSetup.accountId),
          eq(identitySecurityEvents.eventType, 'password_credential_created'),
        ),
      );
    expect(createdEvents).toHaveLength(1);
  });

  it('rejects expired and revoked password-setup grants without mutating state', async () => {
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
            .where(
              and(
                eq(setupGrants.accountId, accountId),
                eq(setupGrants.purpose, 'initial_password_setup'),
              ),
            );
        },
      },
      {
        name: 'revoked',
        mutate: async (accountId) => {
          await currentApp()
            .database.db.update(setupGrants)
            .set({ revokedAt: FIXED_NOW })
            .where(
              and(
                eq(setupGrants.accountId, accountId),
                eq(setupGrants.purpose, 'initial_password_setup'),
              ),
            );
        },
      },
    ];

    for (const testCase of cases) {
      await boot();
      const emailSetup = await completeEmailSetup(
        currentApp(),
        currentDelivery(),
        `Password.${testCase.name}+grant@example.com`,
      );
      await testCase.mutate(emailSetup.accountId);

      const response = await currentApp().inject({
        method: 'POST',
        url: '/v1/account/password',
        headers: { authorization: `SetupGrant ${emailSetup.setupGrant}` },
        payload: { password: TEST_INITIAL_PASSWORD },
      });
      expect(response.statusCode, testCase.name).toBe(400);
      expect(response.json(), testCase.name).toMatchObject(FAILURE_BODY);
      await assertNoPasswordSetupSideEffects(emailSetup.accountId);
    }
  });

  it('rejects password setup when the account is no longer pending_password', async () => {
    for (const status of ['pending_passkey', 'active'] as const) {
      await boot();
      const emailSetup = await completeEmailSetup(
        currentApp(),
        currentDelivery(),
        `Password.State.${status}+ok@example.com`,
      );

      if (status === 'pending_passkey') {
        await currentApp()
          .database.db.update(accounts)
          .set({ status: 'pending_passkey', updatedAt: FIXED_NOW })
          .where(eq(accounts.id, emailSetup.accountId));
      } else {
        await currentApp()
          .database.db.update(accounts)
          .set({
            status: 'active',
            webauthnUserHandle: Buffer.alloc(32, 7),
            accountReadyAt: FIXED_NOW,
            updatedAt: FIXED_NOW,
          })
          .where(eq(accounts.id, emailSetup.accountId));
      }

      const response = await currentApp().inject({
        method: 'POST',
        url: '/v1/account/password',
        headers: { authorization: `SetupGrant ${emailSetup.setupGrant}` },
        payload: { password: TEST_INITIAL_PASSWORD },
      });
      expect(response.statusCode, status).toBe(400);
      expect(response.json(), status).toMatchObject(FAILURE_BODY);

      const db = currentApp().database.db;
      expect(
        (
          await db
            .select({ value: count() })
            .from(accountPasswordCredentials)
            .where(eq(accountPasswordCredentials.accountId, emailSetup.accountId))
        )[0]?.value,
        status,
      ).toBe(0);
      expect(
        (await db.select().from(accounts).where(eq(accounts.id, emailSetup.accountId)))[0]?.status,
        status,
      ).toBe(status);
      expect(
        (
          await db
            .select({ value: count() })
            .from(setupGrants)
            .where(
              and(
                eq(setupGrants.accountId, emailSetup.accountId),
                eq(setupGrants.purpose, 'initial_passkey_registration'),
              ),
            )
        )[0]?.value,
        status,
      ).toBe(0);
      expect((await db.select({ value: count() }).from(accountSessions))[0]?.value, status).toBe(0);
    }
  });

  it('rejects retry after an active password credential already exists', async () => {
    const emailSetup = await completeEmailSetup(
      currentApp(),
      currentDelivery(),
      'Password.Retry+exists@example.com',
    );

    const first = await currentApp().inject({
      method: 'POST',
      url: '/v1/account/password',
      headers: { authorization: `SetupGrant ${emailSetup.setupGrant}` },
      payload: { password: TEST_INITIAL_PASSWORD },
    });
    expect(first.statusCode).toBe(200);
    const firstPasskeyGrant = first.json<{ data: { setupGrant: string } }>().data.setupGrant;

    const replaySameGrant = await currentApp().inject({
      method: 'POST',
      url: '/v1/account/password',
      headers: { authorization: `SetupGrant ${emailSetup.setupGrant}` },
      payload: { password: `${TEST_INITIAL_PASSWORD}-retry` },
    });
    expect(replaySameGrant.statusCode).toBe(400);
    expect(replaySameGrant.json()).toMatchObject(FAILURE_BODY);

    // Force a fresh password-purpose grant while the credential remains active.
    await currentApp()
      .database.db.update(accounts)
      .set({ status: 'pending_password', updatedAt: FIXED_NOW })
      .where(eq(accounts.id, emailSetup.accountId));

    const retryToken = `retry-password-grant-${randomUUID()}`;
    const retryTokenHash = hashOpaqueToken({
      hashKey: TEST_EMAIL_VERIFICATION_HASH_KEY,
      purpose: 'initial_password_setup',
      token: retryToken,
    });
    await currentApp()
      .database.db.insert(setupGrants)
      .values({
        id: randomUUID(),
        accountId: emailSetup.accountId,
        tokenHash: retryTokenHash,
        purpose: 'initial_password_setup',
        createdAt: FIXED_NOW,
        expiresAt: toIsoTimestamp(new Date(Date.parse(FIXED_NOW) + 15 * 60_000).toISOString()),
        consumedAt: null,
        revokedAt: null,
      });

    const retryFreshGrant = await currentApp().inject({
      method: 'POST',
      url: '/v1/account/password',
      headers: { authorization: `SetupGrant ${retryToken}` },
      payload: { password: `${TEST_INITIAL_PASSWORD}-again` },
    });
    expect(retryFreshGrant.statusCode).toBe(400);
    expect(retryFreshGrant.json()).toMatchObject(FAILURE_BODY);

    const db = currentApp().database.db;
    const activeCredentials = await db
      .select()
      .from(accountPasswordCredentials)
      .where(
        and(
          eq(accountPasswordCredentials.accountId, emailSetup.accountId),
          isNull(accountPasswordCredentials.revokedAt),
        ),
      );
    expect(activeCredentials).toHaveLength(1);

    const usablePasskeyGrants = await db
      .select()
      .from(setupGrants)
      .where(
        and(
          eq(setupGrants.accountId, emailSetup.accountId),
          eq(setupGrants.purpose, 'initial_passkey_registration'),
          isNull(setupGrants.consumedAt),
          isNull(setupGrants.revokedAt),
        ),
      );
    expect(usablePasskeyGrants).toHaveLength(1);

    // Account remains pending_password after the forced retry attempt (no second transition).
    expect(
      (await db.select().from(accounts).where(eq(accounts.id, emailSetup.accountId)))[0]?.status,
    ).toBe('pending_password');
    expect((await db.select({ value: count() }).from(accountSessions))[0]?.value).toBe(0);

    // Original passkey handoff token is still the only success payload from first setup.
    expect(firstPasskeyGrant).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(JSON.stringify(retryFreshGrant.json())).not.toContain(firstPasskeyGrant);
  });
});

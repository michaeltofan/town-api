import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { count, eq } from 'drizzle-orm';
import type { AppInstance } from '../src/app.js';
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
});

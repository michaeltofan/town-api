import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, count, eq, isNull } from 'drizzle-orm';
import { Pool } from 'pg';
import type { AppInstance } from '../src/app.js';
import { buildApp } from '../src/app.js';
import { hashRateLimitSubject } from '../src/ceremony/email-verification/crypto.js';
import { PASSWORD_SIGN_IN_EMAIL_LIMIT_30M } from '../src/ceremony/password-authentication/policy.js';
import { authenticateWithPassword } from '../src/ceremony/password-authentication/service.js';
import {
  accountEmails,
  accountPasswordCredentials,
  accountSessions,
  accounts,
  actors,
  ceremonyRateLimits,
  identitySecurityEvents,
  passkeyCredentials,
} from '../src/db/schema.js';
import { normalizeEmail } from '../src/identity/email-normalize.js';
import { revokeEmail } from '../src/identity/repositories/emails.js';
import { transitionAccountState } from '../src/identity/repositories/accounts.js';
import { revokeAccountPasswordCredential } from '../src/identity/repositories/password-credentials.js';
import { authenticatePasskey } from './helpers/passkey-authentication.js';
import {
  completeEmailAndPasswordSetup,
  completeEmailSetup,
  TEST_INITIAL_PASSWORD,
  TEST_ORIGIN,
  TEST_RP_ID,
} from './helpers/passkey-registration.js';
import { createSoftPasskeyMaterial } from './helpers/webauthn-soft-authenticator.js';
import {
  createPasswordSignInEnv,
  createPasswordSignInTestApp,
  registerActivePasskeyAccount,
  signInWithPassword,
  TEST_CEREMONY_RATE_LIMIT_HASH_KEY,
  TEST_WEB_SESSION_COOKIE_NAME,
} from './helpers/password-authentication.js';

const FIXED_NOW = '2026-07-29T12:00:00.000Z';
const FAILURE_BODY = {
  error: {
    code: 'AUTHENTICATION_FAILED',
    message: 'Authentication could not be completed.',
  },
};

function setCookieHeaders(response: { headers: Record<string, unknown> }): string[] {
  const value = response.headers['set-cookie'];
  if (Array.isArray(value)) {
    return value.map(String);
  }
  if (typeof value === 'string') {
    return [value];
  }
  return [];
}

function sessionCookieFrom(response: { headers: Record<string, unknown> }): string {
  const header = setCookieHeaders(response).find((candidate) =>
    candidate.startsWith(`${TEST_WEB_SESSION_COOKIE_NAME}=`),
  );
  if (!header) {
    throw new Error('expected session Set-Cookie header');
  }
  return header.split(';', 1)[0] ?? '';
}

function assertFailureEnvelope(response: {
  statusCode: number;
  json: () => { error: { code: string; message: string } };
  body: string;
}): void {
  expect(response.statusCode).toBe(400);
  const body = response.json();
  expect(body.error.code).toBe(FAILURE_BODY.error.code);
  expect(body.error.message).toBe(FAILURE_BODY.error.message);
  expect(response.body).not.toMatch(/password|argon2|\$argon|phc|@example\.com/i);
}

describe('password sign-in API', () => {
  let app: AppInstance | undefined;
  let pool: Awaited<ReturnType<typeof createPasswordSignInTestApp>>['pool'] | undefined;
  let delivery: Awaited<ReturnType<typeof createPasswordSignInTestApp>>['delivery'] | undefined;
  let env: Awaited<ReturnType<typeof createPasswordSignInTestApp>>['env'] | undefined;
  let capturedLogs: string[] = [];

  async function boot(
    options?: Parameters<typeof createPasswordSignInTestApp>[0] & {
      captureLogs?: boolean;
    },
  ) {
    if (app !== undefined) {
      await app.close();
      app = undefined;
    }
    if (pool !== undefined) {
      await pool.end();
      pool = undefined;
    }
    capturedLogs = [];
    const created = await createPasswordSignInTestApp({
      now: () => FIXED_NOW,
      ...options,
    });
    app = created.app;
    pool = created.pool;
    delivery = created.delivery;
    env = created.env;

    if (options?.captureLogs) {
      const originalInfo = app.log.info.bind(app.log);
      app.log.info = (obj: unknown, msg?: string) => {
        capturedLogs.push(JSON.stringify({ obj, msg }));
        originalInfo(obj, msg);
      };
    }

    return created;
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

  function currentEnv(): NonNullable<typeof env> {
    if (env === undefined) {
      throw new Error('env not initialized');
    }
    return env;
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

  it('returns 404 when PASSWORD_SIGN_IN_ENABLED is false', async () => {
    await boot({ passwordSignInEnabled: false });
    const response = await signInWithPassword({
      app: currentApp(),
      email: 'disabled@example.com',
      clientType: 'web',
    });
    expect(response.statusCode).toBe(404);
  });

  it('creates a web session cookie without exposing a token in JSON', async () => {
    const registered = await registerActivePasskeyAccount(
      currentApp(),
      currentDelivery(),
      'Password.SignIn+web@example.com',
    );

    const response = await signInWithPassword({
      app: currentApp(),
      email: 'Password.SignIn+web@example.com',
      clientType: 'web',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { status: 'AUTHENTICATED' } });
    expect(JSON.stringify(response.json())).not.toMatch(/sessionToken|accountId|password/i);

    const cookies = setCookieHeaders(response);
    expect(cookies.some((value) => value.includes('HttpOnly'))).toBe(true);
    expect(cookies.some((value) => value.includes('Secure'))).toBe(true);
    expect(cookies.some((value) => value.includes('SameSite=Lax'))).toBe(true);
    expect(sessionCookieFrom(response)).toContain(`${TEST_WEB_SESSION_COOKIE_NAME}=`);

    const sessions = await currentApp()
      .database.db.select()
      .from(accountSessions)
      .where(
        and(eq(accountSessions.accountId, registered.accountId), isNull(accountSessions.revokedAt)),
      );
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.clientType).toBe('web');
    expect(sessions[0]?.authenticatedPasskeyId).toBeNull();
  });

  it('returns a mobile session token and does not set the web cookie', async () => {
    const registered = await registerActivePasskeyAccount(
      currentApp(),
      currentDelivery(),
      'Password.SignIn+mobile@example.com',
    );

    const response = await signInWithPassword({
      app: currentApp(),
      email: 'Password.SignIn+mobile@example.com',
      clientType: 'mobile',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      data: { status: string; sessionToken: string; sessionExpiresAt: string };
    }>();
    expect(body.data.status).toBe('AUTHENTICATED');
    expect(body.data.sessionToken.length).toBeGreaterThan(20);
    expect(body.data.sessionExpiresAt).toBeTruthy();
    expect(
      setCookieHeaders(response).some((value) => value.includes(TEST_WEB_SESSION_COOKIE_NAME)),
    ).toBe(false);

    const sessions = await currentApp()
      .database.db.select()
      .from(accountSessions)
      .where(
        and(eq(accountSessions.accountId, registered.accountId), isNull(accountSessions.revokedAt)),
      );
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.clientType).toBe('mobile');
  });

  it('binds the session to the same canonical account as email, password, and passkey', async () => {
    const email = 'Password.SignIn+canonical@example.com';
    const registered = await registerActivePasskeyAccount(currentApp(), currentDelivery(), email);

    const response = await signInWithPassword({
      app: currentApp(),
      email,
      clientType: 'mobile',
    });
    expect(response.statusCode).toBe(200);

    const emailRow = (
      await currentApp()
        .database.db.select()
        .from(accountEmails)
        .where(eq(accountEmails.emailNormalized, normalizeEmail(email)))
        .limit(1)
    )[0];
    const passwordRow = (
      await currentApp()
        .database.db.select()
        .from(accountPasswordCredentials)
        .where(
          and(
            eq(accountPasswordCredentials.accountId, registered.accountId),
            isNull(accountPasswordCredentials.revokedAt),
          ),
        )
        .limit(1)
    )[0];
    const passkeyRow = (
      await currentApp()
        .database.db.select()
        .from(passkeyCredentials)
        .where(
          and(
            eq(passkeyCredentials.accountId, registered.accountId),
            isNull(passkeyCredentials.revokedAt),
          ),
        )
        .limit(1)
    )[0];
    const sessionRow = (
      await currentApp()
        .database.db.select()
        .from(accountSessions)
        .where(
          and(
            eq(accountSessions.accountId, registered.accountId),
            isNull(accountSessions.revokedAt),
          ),
        )
        .limit(1)
    )[0];
    const actorRow = (
      await currentApp()
        .database.db.select()
        .from(actors)
        .where(eq(actors.accountId, registered.accountId))
        .limit(1)
    )[0];

    expect(emailRow?.accountId).toBe(registered.accountId);
    expect(passwordRow?.accountId).toBe(registered.accountId);
    expect(passkeyRow?.accountId).toBe(registered.accountId);
    expect(sessionRow?.accountId).toBe(registered.accountId);
    expect(actorRow?.accountId).toBe(registered.accountId);
  });

  it('creates no account and no credential on password sign-in', async () => {
    const email = 'Password.SignIn+nocreate@example.com';
    const registered = await registerActivePasskeyAccount(currentApp(), currentDelivery(), email);

    const accountsBefore = await currentApp().database.db.select({ value: count() }).from(accounts);
    const passwordsBefore = await currentApp()
      .database.db.select({ value: count() })
      .from(accountPasswordCredentials);
    const passkeysBefore = await currentApp()
      .database.db.select({ value: count() })
      .from(passkeyCredentials);

    const response = await signInWithPassword({
      app: currentApp(),
      email,
      clientType: 'web',
    });
    expect(response.statusCode).toBe(200);

    const accountsAfter = await currentApp().database.db.select({ value: count() }).from(accounts);
    const passwordsAfter = await currentApp()
      .database.db.select({ value: count() })
      .from(accountPasswordCredentials);
    const passkeysAfter = await currentApp()
      .database.db.select({ value: count() })
      .from(passkeyCredentials);

    expect(accountsAfter[0]?.value).toBe(accountsBefore[0]?.value);
    expect(passwordsAfter[0]?.value).toBe(passwordsBefore[0]?.value);
    expect(passkeysAfter[0]?.value).toBe(passkeysBefore[0]?.value);

    const account = (
      await currentApp()
        .database.db.select()
        .from(accounts)
        .where(eq(accounts.id, registered.accountId))
        .limit(1)
    )[0];
    expect(account?.status).toBe('active');
  });

  it('returns identical failure envelopes for wrong password and unknown email', async () => {
    const email = 'Password.SignIn+wrong@example.com';
    await registerActivePasskeyAccount(currentApp(), currentDelivery(), email);

    const wrong = await signInWithPassword({
      app: currentApp(),
      email,
      password: 'definitely-not-the-password',
      clientType: 'web',
    });
    const unknown = await signInWithPassword({
      app: currentApp(),
      email: 'Password.SignIn+unknown@example.com',
      password: 'definitely-not-the-password',
      clientType: 'web',
    });

    assertFailureEnvelope(wrong);
    assertFailureEnvelope(unknown);
    expect(wrong.json()).toMatchObject(FAILURE_BODY);
    expect(unknown.json()).toMatchObject(FAILURE_BODY);
    expect(wrong.statusCode).toBe(unknown.statusCode);
  });

  it('fails identically for revoked email and missing/revoked password credential', async () => {
    const email = 'Password.SignIn+revoked-email@example.com';
    const registered = await registerActivePasskeyAccount(currentApp(), currentDelivery(), email);

    const emailRow = (
      await currentApp()
        .database.db.select()
        .from(accountEmails)
        .where(eq(accountEmails.accountId, registered.accountId))
        .limit(1)
    )[0];
    if (!emailRow) {
      throw new Error('expected email row');
    }
    await revokeEmail(currentApp().database.db, {
      emailId: emailRow.id,
      revokedAt: FIXED_NOW,
    });

    const revokedEmail = await signInWithPassword({
      app: currentApp(),
      email,
      clientType: 'web',
    });
    assertFailureEnvelope(revokedEmail);

    await boot();
    const email2 = 'Password.SignIn+revoked-password@example.com';
    const registered2 = await registerActivePasskeyAccount(currentApp(), currentDelivery(), email2);
    await revokeAccountPasswordCredential(currentApp().database.db, {
      accountId: registered2.accountId,
      revokedAt: FIXED_NOW,
    });

    const revokedPassword = await signInWithPassword({
      app: currentApp(),
      email: email2,
      clientType: 'web',
    });
    assertFailureEnvelope(revokedPassword);
    const revokedEmailBody = revokedEmail.json<{ error: { code: string; message: string } }>();
    const revokedPasswordBody = revokedPassword.json<{
      error: { code: string; message: string };
    }>();
    expect(revokedEmailBody.error.code).toBe(revokedPasswordBody.error.code);
    expect(revokedEmailBody.error.message).toBe(revokedPasswordBody.error.message);
  });

  it('rejects pending_email, pending_password, pending_passkey, suspended, and closed accounts', async () => {
    const pendingEmailRequest = await currentApp().inject({
      method: 'POST',
      url: '/v1/account/email-verifications',
      payload: { email: 'Password.SignIn+pending-email@example.com' },
    });
    expect(pendingEmailRequest.statusCode).toBe(202);
    assertFailureEnvelope(
      await signInWithPassword({
        app: currentApp(),
        email: 'Password.SignIn+pending-email@example.com',
        clientType: 'web',
      }),
    );

    const pendingPassword = await completeEmailSetup(
      currentApp(),
      currentDelivery(),
      'Password.SignIn+pending-password@example.com',
    );
    const pendingPasswordAccount = (
      await currentApp()
        .database.db.select()
        .from(accounts)
        .where(eq(accounts.id, pendingPassword.accountId))
        .limit(1)
    )[0];
    expect(pendingPasswordAccount?.status).toBe('pending_password');
    assertFailureEnvelope(
      await signInWithPassword({
        app: currentApp(),
        email: 'Password.SignIn+pending-password@example.com',
        clientType: 'web',
      }),
    );

    const pendingPasskey = await completeEmailAndPasswordSetup(
      currentApp(),
      currentDelivery(),
      'Password.SignIn+pending-passkey@example.com',
    );
    const pendingPasskeyAccount = (
      await currentApp()
        .database.db.select()
        .from(accounts)
        .where(eq(accounts.id, pendingPasskey.accountId))
        .limit(1)
    )[0];
    expect(pendingPasskeyAccount?.status).toBe('pending_passkey');
    assertFailureEnvelope(
      await signInWithPassword({
        app: currentApp(),
        email: 'Password.SignIn+pending-passkey@example.com',
        clientType: 'web',
      }),
    );

    const suspendedEmail = 'Password.SignIn+suspended@example.com';
    const suspended = await registerActivePasskeyAccount(
      currentApp(),
      currentDelivery(),
      suspendedEmail,
    );
    await transitionAccountState(currentApp().database.db, {
      accountId: suspended.accountId,
      to: 'suspended',
      at: FIXED_NOW,
    });
    assertFailureEnvelope(
      await signInWithPassword({
        app: currentApp(),
        email: suspendedEmail,
        clientType: 'web',
      }),
    );

    const closedEmail = 'Password.SignIn+closed@example.com';
    const closed = await registerActivePasskeyAccount(currentApp(), currentDelivery(), closedEmail);
    await transitionAccountState(currentApp().database.db, {
      accountId: closed.accountId,
      to: 'closed',
      at: FIXED_NOW,
    });
    assertFailureEnvelope(
      await signInWithPassword({
        app: currentApp(),
        email: closedEmail,
        clientType: 'web',
      }),
    );

    const sessions = await currentApp()
      .database.db.select({ value: count() })
      .from(accountSessions)
      .where(isNull(accountSessions.revokedAt));
    expect(sessions[0]?.value).toBe(0);
  });

  it('creates no session on every failure path', async () => {
    const email = 'Password.SignIn+fail-session@example.com';
    await registerActivePasskeyAccount(currentApp(), currentDelivery(), email);

    await signInWithPassword({
      app: currentApp(),
      email,
      password: 'wrong-password-value',
      clientType: 'web',
    });
    await signInWithPassword({
      app: currentApp(),
      email: 'Password.SignIn+missing@example.com',
      clientType: 'mobile',
    });

    const sessions = await currentApp()
      .database.db.select({ value: count() })
      .from(accountSessions);
    expect(sessions[0]?.value).toBe(0);
  });

  it('rate limits by normalized email and IP without persisting raw email', async () => {
    const email = 'Password.SignIn+rate-email@example.com';
    await registerActivePasskeyAccount(currentApp(), currentDelivery(), email);

    for (let i = 0; i < PASSWORD_SIGN_IN_EMAIL_LIMIT_30M; i += 1) {
      assertFailureEnvelope(
        await signInWithPassword({
          app: currentApp(),
          email,
          password: 'wrong-password-value',
          clientType: 'web',
          remoteAddress: '127.0.0.40',
        }),
      );
    }

    assertFailureEnvelope(
      await signInWithPassword({
        app: currentApp(),
        email,
        password: 'wrong-password-value',
        clientType: 'web',
        remoteAddress: '127.0.0.40',
      }),
    );

    const emailBuckets = await currentApp()
      .database.db.select()
      .from(ceremonyRateLimits)
      .where(eq(ceremonyRateLimits.scope, 'password_sign_in_email'));
    expect(emailBuckets.length).toBeGreaterThan(0);

    const expectedSubjectHash = hashRateLimitSubject({
      hashKey: TEST_CEREMONY_RATE_LIMIT_HASH_KEY,
      scope: 'password_sign_in_email',
      subject: `email:${normalizeEmail(email)}:30m`,
    });
    expect(
      emailBuckets.some((bucket) => Buffer.compare(bucket.subjectHash, expectedSubjectHash) === 0),
    ).toBe(true);

    for (const bucket of emailBuckets) {
      expect(Buffer.isBuffer(bucket.subjectHash)).toBe(true);
      expect(bucket.subjectHash.toString('utf8')).not.toContain('example.com');
      expect(bucket.subjectHash.toString('utf8')).not.toContain(email);
    }

    await boot();
    for (let i = 0; i < 30; i += 1) {
      assertFailureEnvelope(
        await signInWithPassword({
          app: currentApp(),
          email: `Password.SignIn+rate-ip-${String(i)}@example.com`,
          password: 'wrong-password-value',
          clientType: 'web',
          remoteAddress: '127.0.0.41',
        }),
      );
    }
    assertFailureEnvelope(
      await signInWithPassword({
        app: currentApp(),
        email: 'Password.SignIn+rate-ip-final@example.com',
        password: 'wrong-password-value',
        clientType: 'web',
        remoteAddress: '127.0.0.41',
      }),
    );

    const ipBuckets = await currentApp()
      .database.db.select()
      .from(ceremonyRateLimits)
      .where(eq(ceremonyRateLimits.scope, 'password_sign_in_ip'));
    expect(ipBuckets.length).toBeGreaterThan(0);
  });

  it('cannot produce a session when credential is revoked before transaction commit', async () => {
    const email = 'Password.SignIn+concurrent@example.com';
    const registered = await registerActivePasskeyAccount(currentApp(), currentDelivery(), email);
    const dbUrl = currentEnv().DATABASE_URL;

    const holder = new Pool({ connectionString: dbUrl, max: 1 });
    const client = await holder.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT id FROM town.account_password_credentials
         WHERE account_id = $1 AND revoked_at IS NULL
         FOR UPDATE`,
        [registered.accountId],
      );

      const signInPromise = authenticateWithPassword(
        currentApp().database.db,
        {
          env: currentEnv(),
          now: () => FIXED_NOW,
        },
        {
          email,
          password: TEST_INITIAL_PASSWORD,
          clientType: 'web',
          ip: '127.0.0.50',
          requestId: 'concurrent-test',
        },
      );

      await new Promise((resolve) => setTimeout(resolve, 150));

      await client.query(
        `UPDATE town.account_password_credentials
         SET revoked_at = $2::timestamptz, updated_at = $2::timestamptz
         WHERE account_id = $1 AND revoked_at IS NULL`,
        [registered.accountId, FIXED_NOW],
      );
      await client.query('COMMIT');

      await expect(signInPromise).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
    } finally {
      try {
        await client.query('ROLLBACK');
      } catch {
        // already committed/rolled back
      }
      client.release();
      await holder.end();
    }

    const sessions = await currentApp()
      .database.db.select({ value: count() })
      .from(accountSessions)
      .where(eq(accountSessions.accountId, registered.accountId));
    expect(sessions[0]?.value).toBe(0);
  });

  it('cannot produce a session when account is suspended under a held lock', async () => {
    const email = 'Password.SignIn+concurrent-suspend@example.com';
    const registered = await registerActivePasskeyAccount(currentApp(), currentDelivery(), email);
    const dbUrl = currentEnv().DATABASE_URL;

    const holder = new Pool({ connectionString: dbUrl, max: 1 });
    const client = await holder.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM town.accounts WHERE id = $1 FOR UPDATE', [
        registered.accountId,
      ]);

      const signInPromise = authenticateWithPassword(
        currentApp().database.db,
        { env: currentEnv(), now: () => FIXED_NOW },
        {
          email,
          password: TEST_INITIAL_PASSWORD,
          clientType: 'web',
          ip: '127.0.0.51',
          requestId: 'concurrent-suspend',
        },
      );

      await new Promise((resolve) => setTimeout(resolve, 150));

      await client.query(
        `UPDATE town.accounts
         SET status = 'suspended', suspended_at = $2::timestamptz, updated_at = $2::timestamptz
         WHERE id = $1`,
        [registered.accountId, FIXED_NOW],
      );
      await client.query('COMMIT');

      await expect(signInPromise).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
    } finally {
      try {
        await client.query('ROLLBACK');
      } catch {
        // already committed/rolled back
      }
      client.release();
      await holder.end();
    }

    const sessions = await currentApp()
      .database.db.select({ value: count() })
      .from(accountSessions)
      .where(eq(accountSessions.accountId, registered.accountId));
    expect(sessions[0]?.value).toBe(0);
  });

  it('cannot produce a session when primary email is revoked under a held lock', async () => {
    const email = 'Password.SignIn+concurrent-email@example.com';
    const registered = await registerActivePasskeyAccount(currentApp(), currentDelivery(), email);
    const emailRow = (
      await currentApp()
        .database.db.select()
        .from(accountEmails)
        .where(eq(accountEmails.accountId, registered.accountId))
        .limit(1)
    )[0];
    if (!emailRow) {
      throw new Error('expected email row');
    }
    const dbUrl = currentEnv().DATABASE_URL;

    const holder = new Pool({ connectionString: dbUrl, max: 1 });
    const client = await holder.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM town.account_emails WHERE id = $1 FOR UPDATE', [
        emailRow.id,
      ]);

      const signInPromise = authenticateWithPassword(
        currentApp().database.db,
        { env: currentEnv(), now: () => FIXED_NOW },
        {
          email,
          password: TEST_INITIAL_PASSWORD,
          clientType: 'web',
          ip: '127.0.0.52',
          requestId: 'concurrent-email',
        },
      );

      await new Promise((resolve) => setTimeout(resolve, 150));

      await client.query(
        `UPDATE town.account_emails
         SET revoked_at = $2::timestamptz, is_primary = false, updated_at = $2::timestamptz
         WHERE id = $1`,
        [emailRow.id, FIXED_NOW],
      );
      await client.query('COMMIT');

      await expect(signInPromise).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
    } finally {
      try {
        await client.query('ROLLBACK');
      } catch {
        // already committed/rolled back
      }
      client.release();
      await holder.end();
    }

    const sessions = await currentApp()
      .database.db.select({ value: count() })
      .from(accountSessions)
      .where(eq(accountSessions.accountId, registered.accountId));
    expect(sessions[0]?.value).toBe(0);
  });

  it('verifies NFC-equivalent passwords through the public route', async () => {
    const composed = 'cafe\u0301-password-signin';
    const precomposed = 'caf\u00e9-password-signin';
    expect(composed.normalize('NFC')).toBe(precomposed.normalize('NFC'));

    const email = 'Password.SignIn+nfc@example.com';
    const setup = await completeEmailAndPasswordSetup(
      currentApp(),
      currentDelivery(),
      email,
      composed,
    );
    const optionsResponse = await currentApp().inject({
      method: 'POST',
      url: '/v1/account/passkeys/registration/options',
      headers: { authorization: `SetupGrant ${setup.setupGrant}` },
      payload: {},
    });
    expect(optionsResponse.statusCode).toBe(200);
    const options = optionsResponse.json<{
      data: {
        registrationCeremonyId: string;
        options: { challenge: string; user: { id: string } };
      };
    }>();
    const material = createSoftPasskeyMaterial();
    const verifyResponse = await currentApp().inject({
      method: 'POST',
      url: '/v1/account/passkeys/registration/verify',
      headers: { authorization: `SetupGrant ${setup.setupGrant}` },
      payload: {
        registrationCeremonyId: options.data.registrationCeremonyId,
        response: material.createRegistrationResponse({
          challenge: options.data.options.challenge,
          rpID: TEST_RP_ID,
          origin: TEST_ORIGIN,
        }),
      },
    });
    expect(verifyResponse.statusCode).toBe(200);

    const response = await signInWithPassword({
      app: currentApp(),
      email,
      password: precomposed,
      clientType: 'mobile',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ data: { status: string } }>().data.status).toBe('AUTHENTICATED');
  });

  it('omits password, PHC hash, and email from responses, events, and logs', async () => {
    await boot({ captureLogs: true });
    const email = 'Password.SignIn+sensitive@example.com';
    await registerActivePasskeyAccount(currentApp(), currentDelivery(), email);
    capturedLogs = [];

    const success = await signInWithPassword({
      app: currentApp(),
      email,
      clientType: 'web',
    });
    expect(success.statusCode).toBe(200);
    expect(JSON.stringify(success.json())).not.toMatch(/password|argon2|\$argon|@example\.com/i);

    const failure = await signInWithPassword({
      app: currentApp(),
      email,
      password: 'wrong-password-value',
      clientType: 'web',
    });
    assertFailureEnvelope(failure);

    const events = await currentApp().database.db.select().from(identitySecurityEvents);
    const authEvents = events.filter(
      (event) =>
        event.eventType === 'authentication_failed' ||
        event.eventType === 'authentication_succeeded' ||
        event.eventType === 'session_created' ||
        event.eventType === 'rate_limit_triggered',
    );
    for (const event of authEvents) {
      const metadata = JSON.stringify(event.metadata ?? {});
      expect(metadata).not.toMatch(/\$argon2id\$/);
      expect(metadata).not.toContain(TEST_INITIAL_PASSWORD);
      expect(metadata).not.toContain('Password.SignIn+sensitive@example.com');
      expect(metadata).not.toMatch(/"password"\s*:/);
      expect(metadata).not.toContain('wrong-password-value');
    }

    const applicationLogs = capturedLogs.filter((entry) =>
      entry.includes('password_authentication'),
    );
    expect(applicationLogs.length).toBeGreaterThan(0);
    for (const entry of applicationLogs) {
      expect(entry).not.toContain(TEST_INITIAL_PASSWORD);
      expect(entry).not.toContain('wrong-password-value');
      expect(entry).not.toMatch(/\$argon2id\$/);
      expect(entry).not.toContain('Password.SignIn+sensitive@example.com');
    }
  });

  it('leaves passkey authentication and session rotation/logout unchanged', async () => {
    const email = 'Password.SignIn+passkey-compat@example.com';
    const registered = await registerActivePasskeyAccount(currentApp(), currentDelivery(), email);

    const passwordSignIn = await signInWithPassword({
      app: currentApp(),
      email,
      clientType: 'web',
    });
    expect(passwordSignIn.statusCode).toBe(200);

    const { verifyResponse } = await authenticatePasskey({
      app: currentApp(),
      material: registered.material,
      clientType: 'mobile',
      userHandle: registered.userHandle,
    });
    expect(verifyResponse.statusCode).toBe(200);
    const mobile = verifyResponse.json<{
      data: { status: string; sessionToken: string };
    }>();
    expect(mobile.data.status).toBe('AUTHENTICATED');

    const rotate = await currentApp().inject({
      method: 'POST',
      url: '/v1/authentication/session/rotate',
      headers: { authorization: `Session ${mobile.data.sessionToken}` },
    });
    expect(rotate.statusCode).toBe(200);
    const rotated = rotate.json<{ data: { status: string; sessionToken: string } }>();
    expect(rotated.data.status).toBe('AUTHENTICATED');

    const logout = await currentApp().inject({
      method: 'POST',
      url: '/v1/authentication/logout',
      headers: { authorization: `Session ${rotated.data.sessionToken}` },
    });
    expect(logout.statusCode).toBe(200);
    expect(logout.json()).toEqual({ data: { status: 'SIGNED_OUT' } });
  });

  it('keeps shared session lifecycle usable when only PASSWORD_SIGN_IN_ENABLED is true', async () => {
    let nowMs = Date.parse(FIXED_NOW);
    const email = 'Password.SignIn+independent@example.com';
    await registerActivePasskeyAccount(currentApp(), currentDelivery(), email);

    const database = currentApp().database;
    const rebuiltEnv = createPasswordSignInEnv({
      PASSKEY_AUTHENTICATION_ENABLED: 'false',
      PASSWORD_SIGN_IN_ENABLED: 'true',
      DATABASE_URL: currentEnv().DATABASE_URL,
    });
    const originalClose = database.close.bind(database);
    database.close = () => {
      return Promise.resolve();
    };
    await currentApp().close();
    database.close = originalClose;

    const rebuilt = await buildApp({
      env: rebuiltEnv,
      logger: false,
      database,
      passwordAuthentication: { now: () => new Date(nowMs).toISOString() },
      passkeyAuthentication: { now: () => new Date(nowMs).toISOString() },
    });
    await rebuilt.ready();
    app = rebuilt;
    env = rebuiltEnv;

    const signIn = await signInWithPassword({
      app: rebuilt,
      email,
      clientType: 'mobile',
    });
    expect(signIn.statusCode).toBe(200);
    const signedIn = signIn.json<{
      data: { status: string; sessionToken: string; sessionExpiresAt: string };
    }>();
    expect(signedIn.data.status).toBe('AUTHENTICATED');

    const session = await rebuilt.inject({
      method: 'GET',
      url: '/v1/authentication/session',
      headers: { authorization: `Session ${signedIn.data.sessionToken}` },
    });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({
      data: {
        authenticated: true,
        clientType: 'mobile',
      },
    });

    const rotate = await rebuilt.inject({
      method: 'POST',
      url: '/v1/authentication/session/rotate',
      headers: { authorization: `Session ${signedIn.data.sessionToken}` },
    });
    expect(rotate.statusCode).toBe(200);
    const rotated = rotate.json<{
      data: { status: string; sessionToken: string };
    }>();
    expect(rotated.data.status).toBe('AUTHENTICATED');

    const logout = await rebuilt.inject({
      method: 'POST',
      url: '/v1/authentication/logout',
      headers: { authorization: `Session ${rotated.data.sessionToken}` },
    });
    expect(logout.statusCode).toBe(200);
    expect(logout.json()).toEqual({ data: { status: 'SIGNED_OUT' } });

    const afterLogout = await rebuilt.inject({
      method: 'GET',
      url: '/v1/authentication/session',
      headers: { authorization: `Session ${rotated.data.sessionToken}` },
    });
    expect(afterLogout.json()).toEqual({ data: { authenticated: false } });

    // Fresh password session can logout-all; stale session follows existing freshness rules.
    const freshSignIn = await signInWithPassword({
      app: rebuilt,
      email,
      clientType: 'mobile',
    });
    expect(freshSignIn.statusCode).toBe(200);
    const freshToken = freshSignIn.json<{ data: { sessionToken: string } }>().data.sessionToken;

    const logoutAllFresh = await rebuilt.inject({
      method: 'POST',
      url: '/v1/authentication/logout-all',
      headers: { authorization: `Session ${freshToken}` },
    });
    expect(logoutAllFresh.statusCode).toBe(200);
    expect(logoutAllFresh.json()).toEqual({ data: { status: 'SIGNED_OUT' } });

    const staleSignIn = await signInWithPassword({
      app: rebuilt,
      email,
      clientType: 'mobile',
    });
    expect(staleSignIn.statusCode).toBe(200);
    const staleToken = staleSignIn.json<{ data: { sessionToken: string } }>().data.sessionToken;
    nowMs += 11 * 60_000;
    const logoutAllStale = await rebuilt.inject({
      method: 'POST',
      url: '/v1/authentication/logout-all',
      headers: { authorization: `Session ${staleToken}` },
    });
    expect(logoutAllStale.statusCode).toBe(401);
    expect(logoutAllStale.json()).toMatchObject({
      error: { code: 'RECENT_AUTHENTICATION_REQUIRED' },
    });

    const passkeyOptions = await rebuilt.inject({
      method: 'POST',
      url: '/v1/authentication/passkeys/options',
      payload: { clientType: 'web', anonymousClientKey: 'anonymous-client-key-0001' },
    });
    expect(passkeyOptions.statusCode).toBe(404);

    const passkeyVerify = await rebuilt.inject({
      method: 'POST',
      url: '/v1/authentication/passkeys/verify',
      payload: {
        authenticationCeremonyId: '00000000-0000-4000-8000-000000000099',
        clientType: 'web',
        response: {
          id: 'x',
          rawId: 'x',
          type: 'public-key',
          response: {
            clientDataJSON: 'e30',
            authenticatorData: 'e30',
            signature: 'e30',
          },
        },
      },
    });
    expect(passkeyVerify.statusCode).toBe(404);
  });
});

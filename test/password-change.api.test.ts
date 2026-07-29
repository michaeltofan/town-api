import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { Pool } from 'pg';
import type { AppInstance } from '../src/app.js';
import type { Env } from '../src/config/env.js';
import { CeremonyInvariantError } from '../src/ceremony/errors.js';
import {
  authenticateWithPassword,
  AuthenticationFailedError,
} from '../src/ceremony/password-authentication/service.js';
import {
  changeAccountPassword,
  RateLimitedError,
} from '../src/ceremony/password-change/service.js';
import { PASSWORD_CHANGE_ACCOUNT_LIMIT_30M } from '../src/ceremony/password-change/policy.js';
import { requirePasswordChangeConfig } from '../src/ceremony/password-change/config.js';
import {
  generateSessionToken,
  hashSessionToken,
} from '../src/ceremony/passkey-authentication/crypto.js';
import {
  revokeAccountSession,
  rotateAccountSession,
} from '../src/ceremony/repositories/account-sessions.js';
import {
  hashPassword,
  verifyPassword,
  verifyPasswordStrict,
} from '../src/identity/password-hashing.js';
import {
  accountPasswordCredentials,
  accountSessions,
  ceremonyRateLimits,
  identitySecurityEvents,
} from '../src/db/schema.js';
import {
  changePasswordWithSession,
  createCountdownBarrier,
  createDeferred,
  createPasswordChangeTestApp,
  invokePasswordChangeThroughErrorHandler,
  registerActivePasskeyAccount,
  signInWithPassword,
  TEST_CHANGED_PASSWORD,
  TEST_CHANGED_PASSWORD_B,
  TEST_INITIAL_PASSWORD,
  TEST_ORIGIN,
  TEST_WEB_SESSION_COOKIE_NAME,
  waitForPostgresLockWait,
} from './helpers/password-change.js';

const FIXED_NOW = '2026-07-29T12:00:00.000Z';

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

describe('password change API', () => {
  let app: AppInstance | undefined;
  let pool: Awaited<ReturnType<typeof createPasswordChangeTestApp>>['pool'] | undefined;
  let delivery: Awaited<ReturnType<typeof createPasswordChangeTestApp>>['delivery'] | undefined;
  let env: Env | undefined;

  async function boot(options?: Parameters<typeof createPasswordChangeTestApp>[0]) {
    if (app !== undefined) {
      await app.close();
      app = undefined;
    }
    if (pool !== undefined) {
      await pool.end();
      pool = undefined;
    }
    const created = await createPasswordChangeTestApp({
      now: () => FIXED_NOW,
      ...options,
    });
    app = created.app;
    pool = created.pool;
    delivery = created.delivery;
    env = created.env;
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

  function currentEnv(): Env {
    if (env === undefined) {
      throw new Error('env not initialized');
    }
    return env;
  }

  function currentPool(): Pool {
    if (pool === undefined) {
      throw new Error('pool not initialized');
    }
    return pool;
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

  it('returns 404 when PASSWORD_CHANGE_ENABLED is false', async () => {
    await boot({ passwordChangeEnabled: false });
    const response = await changePasswordWithSession({
      app: currentApp(),
      sessionToken: 'not-a-real-token',
    });
    expect(response.statusCode).toBe(404);
  });

  it('changes password for a mobile session and returns a replacement token', async () => {
    const email = 'Password.Change+mobile@example.com';
    await registerActivePasskeyAccount(currentApp(), currentDelivery(), email);
    const signIn = await signInWithPassword({
      app: currentApp(),
      email,
      clientType: 'mobile',
    });
    expect(signIn.statusCode).toBe(200);
    const signInBody = signIn.json<{
      data: { sessionToken: string; sessionExpiresAt: string };
    }>();

    const change = await changePasswordWithSession({
      app: currentApp(),
      sessionToken: signInBody.data.sessionToken,
      currentPassword: TEST_INITIAL_PASSWORD,
      newPassword: TEST_CHANGED_PASSWORD,
    });
    expect(change.statusCode).toBe(200);
    const body = change.json<{
      data: { status: string; sessionToken: string; sessionExpiresAt: string };
    }>();
    expect(body.data.status).toBe('PASSWORD_CHANGED');
    expect(body.data.sessionToken).toBeTruthy();
    expect(body.data.sessionToken).not.toBe(signInBody.data.sessionToken);
    expect(body.data.sessionExpiresAt).toBe(signInBody.data.sessionExpiresAt);
    expect(setCookieHeaders(change)).toHaveLength(0);

    const oldSessionReuse = await changePasswordWithSession({
      app: currentApp(),
      sessionToken: signInBody.data.sessionToken,
      currentPassword: TEST_CHANGED_PASSWORD,
      newPassword: `${TEST_CHANGED_PASSWORD}-again`,
    });
    expect(oldSessionReuse.statusCode).toBe(401);

    const resignIn = await signInWithPassword({
      app: currentApp(),
      email,
      password: TEST_CHANGED_PASSWORD,
      clientType: 'mobile',
    });
    expect(resignIn.statusCode).toBe(200);
  });

  it('changes password for a web session with CSRF and sets a replacement cookie only', async () => {
    const email = 'Password.Change+web@example.com';
    await registerActivePasskeyAccount(currentApp(), currentDelivery(), email);
    const signIn = await signInWithPassword({
      app: currentApp(),
      email,
      clientType: 'web',
    });
    expect(signIn.statusCode).toBe(200);
    const cookie = sessionCookieFrom(signIn);

    const missingCsrf = await changePasswordWithSession({
      app: currentApp(),
      cookie,
      currentPassword: TEST_INITIAL_PASSWORD,
      newPassword: TEST_CHANGED_PASSWORD,
    });
    expect(missingCsrf.statusCode).toBe(401);

    const change = await changePasswordWithSession({
      app: currentApp(),
      cookie,
      origin: TEST_ORIGIN,
      currentPassword: TEST_INITIAL_PASSWORD,
      newPassword: TEST_CHANGED_PASSWORD,
    });
    expect(change.statusCode).toBe(200);
    const body = change.json<{ data: { status: string; sessionToken?: string } }>();
    expect(body.data.status).toBe('PASSWORD_CHANGED');
    expect(body.data.sessionToken).toBeUndefined();
    const replacementCookie = sessionCookieFrom(change);
    expect(replacementCookie).not.toBe(cookie);

    const events = await currentApp()
      .database.db.select()
      .from(identitySecurityEvents)
      .where(eq(identitySecurityEvents.eventType, 'password_credential_changed'));
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects SetupGrant, RecoveryGrant, and Bearer with SESSION_NOT_AUTHORIZED', async () => {
    for (const authorization of [
      'SetupGrant opaque-token',
      'RecoveryGrant opaque-token',
      'Bearer opaque-token',
    ]) {
      const response = await currentApp().inject({
        method: 'POST',
        url: '/v1/account/password/change',
        headers: { authorization },
        payload: {
          currentPassword: TEST_INITIAL_PASSWORD,
          newPassword: TEST_CHANGED_PASSWORD,
        },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({
        error: { code: 'SESSION_NOT_AUTHORIZED' },
      });
    }
  });

  it('rejects wrong current password with PASSWORD_CHANGE_FAILED and emits failure event', async () => {
    const email = 'Password.Change+mismatch@example.com';
    await registerActivePasskeyAccount(currentApp(), currentDelivery(), email);
    const signIn = await signInWithPassword({
      app: currentApp(),
      email,
      clientType: 'mobile',
    });
    const token = signIn.json<{ data: { sessionToken: string } }>().data.sessionToken;

    const response = await changePasswordWithSession({
      app: currentApp(),
      sessionToken: token,
      currentPassword: 'definitely-not-the-password',
      newPassword: TEST_CHANGED_PASSWORD,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: 'PASSWORD_CHANGE_FAILED',
        message: 'Password change could not be completed.',
      },
    });
    expect(response.body).not.toMatch(/argon2|password_mismatch|phc/i);

    const failures = await currentApp()
      .database.db.select()
      .from(identitySecurityEvents)
      .where(eq(identitySecurityEvents.eventType, 'password_change_failed'));
    expect(
      failures.some(
        (event) =>
          (event.metadata as { failureCategory?: string } | null)?.failureCategory ===
          'password_mismatch',
      ),
    ).toBe(true);
  });

  it('rejects equal current and new passwords without a failure event', async () => {
    const email = 'Password.Change+equal@example.com';
    await registerActivePasskeyAccount(currentApp(), currentDelivery(), email);
    const signIn = await signInWithPassword({
      app: currentApp(),
      email,
      clientType: 'mobile',
    });
    const token = signIn.json<{ data: { sessionToken: string } }>().data.sessionToken;
    const before = await currentApp().database.db.select().from(identitySecurityEvents);

    const response = await changePasswordWithSession({
      app: currentApp(),
      sessionToken: token,
      currentPassword: TEST_INITIAL_PASSWORD,
      newPassword: TEST_INITIAL_PASSWORD,
    });
    expect(response.statusCode).toBe(400);
    const after = await currentApp().database.db.select().from(identitySecurityEvents);
    expect(after).toHaveLength(before.length);
  });

  it('rejects policy-invalid new passwords without a failure event', async () => {
    const email = 'Password.Change+policy@example.com';
    await registerActivePasskeyAccount(currentApp(), currentDelivery(), email);
    const signIn = await signInWithPassword({
      app: currentApp(),
      email,
      clientType: 'mobile',
    });
    const token = signIn.json<{ data: { sessionToken: string } }>().data.sessionToken;
    const before = await currentApp().database.db.select().from(identitySecurityEvents);

    const response = await changePasswordWithSession({
      app: currentApp(),
      sessionToken: token,
      currentPassword: TEST_INITIAL_PASSWORD,
      newPassword: 'short',
    });
    expect(response.statusCode).toBe(400);
    const after = await currentApp().database.db.select().from(identitySecurityEvents);
    expect(after).toHaveLength(before.length);
  });

  it('revokes all other sessions with password_changed', async () => {
    const email = 'Password.Change+revoke-others@example.com';
    const registered = await registerActivePasskeyAccount(currentApp(), currentDelivery(), email);
    const first = await signInWithPassword({
      app: currentApp(),
      email,
      clientType: 'mobile',
    });
    const second = await signInWithPassword({
      app: currentApp(),
      email,
      clientType: 'mobile',
    });
    const firstToken = first.json<{ data: { sessionToken: string } }>().data.sessionToken;
    const secondToken = second.json<{ data: { sessionToken: string } }>().data.sessionToken;

    const change = await changePasswordWithSession({
      app: currentApp(),
      sessionToken: firstToken,
      currentPassword: TEST_INITIAL_PASSWORD,
      newPassword: TEST_CHANGED_PASSWORD,
    });
    expect(change.statusCode).toBe(200);

    const secondReuse = await changePasswordWithSession({
      app: currentApp(),
      sessionToken: secondToken,
      currentPassword: TEST_CHANGED_PASSWORD,
      newPassword: `${TEST_CHANGED_PASSWORD}-2`,
    });
    expect(secondReuse.statusCode).toBe(401);

    const revoked = await currentApp()
      .database.db.select()
      .from(accountSessions)
      .where(
        and(
          eq(accountSessions.accountId, registered.accountId),
          eq(accountSessions.revocationReason, 'password_changed'),
        ),
      );
    expect(revoked.length).toBeGreaterThanOrEqual(1);
  });

  it('replaces the active password credential and preserves absolute expiry on rotation', async () => {
    const email = 'Password.Change+credential@example.com';
    const registered = await registerActivePasskeyAccount(currentApp(), currentDelivery(), email);
    const signIn = await signInWithPassword({
      app: currentApp(),
      email,
      clientType: 'mobile',
    });
    const token = signIn.json<{ data: { sessionToken: string } }>().data.sessionToken;

    const beforeCredential = await currentApp()
      .database.db.select()
      .from(accountPasswordCredentials)
      .where(
        and(
          eq(accountPasswordCredentials.accountId, registered.accountId),
          isNull(accountPasswordCredentials.revokedAt),
        ),
      );
    expect(beforeCredential).toHaveLength(1);
    const beforeSession = await currentApp()
      .database.db.select()
      .from(accountSessions)
      .where(
        and(eq(accountSessions.accountId, registered.accountId), isNull(accountSessions.revokedAt)),
      );
    expect(beforeSession).toHaveLength(1);
    const absoluteExpiresAt = beforeSession[0]?.absoluteExpiresAt;

    const change = await changePasswordWithSession({
      app: currentApp(),
      sessionToken: token,
      currentPassword: TEST_INITIAL_PASSWORD,
      newPassword: TEST_CHANGED_PASSWORD,
    });
    expect(change.statusCode).toBe(200);

    const active = await currentApp()
      .database.db.select()
      .from(accountPasswordCredentials)
      .where(
        and(
          eq(accountPasswordCredentials.accountId, registered.accountId),
          isNull(accountPasswordCredentials.revokedAt),
        ),
      );
    expect(active).toHaveLength(1);
    const activeHash = active[0]?.passwordHash;
    if (activeHash === undefined) {
      throw new Error('expected active password hash');
    }
    expect(active[0]?.id).not.toBe(beforeCredential[0]?.id);
    await expect(verifyPassword(TEST_CHANGED_PASSWORD, activeHash)).resolves.toBe(true);

    const activeSessions = await currentApp()
      .database.db.select()
      .from(accountSessions)
      .where(
        and(eq(accountSessions.accountId, registered.accountId), isNull(accountSessions.revokedAt)),
      );
    expect(activeSessions).toHaveLength(1);
    expect(activeSessions[0]?.absoluteExpiresAt).toBe(absoluteExpiresAt);
  });

  it('rate limits with attempt-10 threshold event and rejects attempt 11 before Argon2', async () => {
    const email = 'Password.Change+ratelimit@example.com';
    const registered = await registerActivePasskeyAccount(currentApp(), currentDelivery(), email);
    const signIn = await signInWithPassword({
      app: currentApp(),
      email,
      clientType: 'mobile',
    });
    const sessions = await currentApp()
      .database.db.select()
      .from(accountSessions)
      .where(
        and(eq(accountSessions.accountId, registered.accountId), isNull(accountSessions.revokedAt)),
      );
    const session = sessions[0];
    if (session === undefined) {
      throw new Error('expected active session');
    }

    let verifyCalls = 0;
    let hashCalls = 0;
    const deps = {
      env: currentEnv(),
      now: () => FIXED_NOW,
      verifyPasswordStrict: async (plaintext: string, storedHash: string) => {
        verifyCalls += 1;
        return verifyPasswordStrict(plaintext, storedHash);
      },
      hashPassword: async (plaintext: string) => {
        hashCalls += 1;
        return hashPassword(plaintext);
      },
    };

    const rateLimitEvents = async () =>
      currentApp()
        .database.db.select()
        .from(identitySecurityEvents)
        .where(
          and(
            eq(identitySecurityEvents.accountId, registered.accountId),
            eq(identitySecurityEvents.eventType, 'rate_limit_triggered'),
          ),
        );

    for (let index = 0; index < 9; index += 1) {
      await expect(
        changeAccountPassword(currentApp().database.db, deps, {
          session,
          currentPassword: 'wrong-password-value',
          newPassword: TEST_CHANGED_PASSWORD,
          requestId: `rate-${String(index + 1)}`,
        }),
      ).rejects.toMatchObject({
        code: 'PASSWORD_CHANGE_FAILED',
        failureCategory: 'password_mismatch',
      });
    }
    expect(verifyCalls).toBe(9);
    expect(hashCalls).toBe(0);
    expect(await rateLimitEvents()).toHaveLength(0);

    await expect(
      changeAccountPassword(currentApp().database.db, deps, {
        session,
        currentPassword: 'wrong-password-value',
        newPassword: TEST_CHANGED_PASSWORD,
        requestId: 'rate-10',
      }),
    ).rejects.toMatchObject({
      code: 'PASSWORD_CHANGE_FAILED',
      failureCategory: 'password_mismatch',
    });
    expect(verifyCalls).toBe(10);
    expect(hashCalls).toBe(0);

    const thresholdEvents = await rateLimitEvents();
    expect(thresholdEvents).toHaveLength(1);
    expect(thresholdEvents[0]?.metadata).toEqual({
      purpose: 'password_change',
      scope: 'password_change_account',
      failureCategory: 'rate_limited',
    });
    const metadataJson = JSON.stringify(thresholdEvents[0]?.metadata);
    expect(metadataJson).not.toMatch(/throttled|crossedLimit/);
    expect(metadataJson).not.toMatch(/argon2|\$argon|@example\.com|wrong-password/i);

    const verifyBeforeEleventh = verifyCalls;
    const hashBeforeEleventh = hashCalls;
    await expect(
      changeAccountPassword(currentApp().database.db, deps, {
        session,
        currentPassword: 'wrong-password-value',
        newPassword: TEST_CHANGED_PASSWORD,
        requestId: 'rate-11',
      }),
    ).rejects.toBeInstanceOf(RateLimitedError);
    expect(verifyCalls).toBe(verifyBeforeEleventh);
    expect(hashCalls).toBe(hashBeforeEleventh);

    const buckets = await currentApp()
      .database.db.select()
      .from(ceremonyRateLimits)
      .where(eq(ceremonyRateLimits.scope, 'password_change_account'));
    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.attemptCount).toBe(PASSWORD_CHANGE_ACCOUNT_LIMIT_30M);
    expect(await rateLimitEvents()).toHaveLength(2);

    // Production HTTP path still returns 429 for the throttled window.
    const token = signIn.json<{ data: { sessionToken: string } }>().data.sessionToken;
    const throttledHttp = await changePasswordWithSession({
      app: currentApp(),
      sessionToken: token,
      currentPassword: 'wrong-password-value',
      newPassword: TEST_CHANGED_PASSWORD,
    });
    expect(throttledHttp.statusCode).toBe(429);
  });

  it('concurrent reservations never exceed the account limit of 10', async () => {
    const email = 'Password.Change+concurrent@example.com';
    const registered = await registerActivePasskeyAccount(currentApp(), currentDelivery(), email);
    const signIn = await signInWithPassword({
      app: currentApp(),
      email,
      clientType: 'mobile',
    });
    expect(signIn.statusCode).toBe(200);
    const sessions = await currentApp()
      .database.db.select()
      .from(accountSessions)
      .where(
        and(eq(accountSessions.accountId, registered.accountId), isNull(accountSessions.revokedAt)),
      );
    const session = sessions[0];
    if (session === undefined) {
      throw new Error('expected active session');
    }

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, index) =>
        changeAccountPassword(
          currentApp().database.db,
          { env: currentEnv(), now: () => FIXED_NOW },
          {
            session,
            currentPassword: 'wrong-password-value',
            newPassword: TEST_CHANGED_PASSWORD,
            requestId: `concurrent-${String(index)}`,
          },
        ),
      ),
    );

    const buckets = await currentApp()
      .database.db.select()
      .from(ceremonyRateLimits)
      .where(eq(ceremonyRateLimits.scope, 'password_change_account'));
    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.attemptCount).toBe(PASSWORD_CHANGE_ACCOUNT_LIMIT_30M);
    expect(results.filter((result) => result.status === 'rejected').length).toBe(20);
  });

  it('returns 500 INTERNAL_ERROR for strict Argon2 failure without failure event or mutation', async () => {
    const email = 'Password.Change+strict-fail@example.com';
    const registered = await registerActivePasskeyAccount(currentApp(), currentDelivery(), email);
    await signInWithPassword({
      app: currentApp(),
      email,
      clientType: 'mobile',
    });
    const sessions = await currentApp()
      .database.db.select()
      .from(accountSessions)
      .where(
        and(eq(accountSessions.accountId, registered.accountId), isNull(accountSessions.revokedAt)),
      );
    const session = sessions[0];
    if (session === undefined) {
      throw new Error('expected active session');
    }
    const beforeCredentials = await currentApp()
      .database.db.select()
      .from(accountPasswordCredentials)
      .where(eq(accountPasswordCredentials.accountId, registered.accountId));
    const beforeSessions = await currentApp()
      .database.db.select()
      .from(accountSessions)
      .where(eq(accountSessions.accountId, registered.accountId));
    const beforeFailures = await currentApp()
      .database.db.select()
      .from(identitySecurityEvents)
      .where(eq(identitySecurityEvents.eventType, 'password_change_failed'));

    const response = await invokePasswordChangeThroughErrorHandler({
      db: currentApp().database.db,
      deps: {
        env: currentEnv(),
        now: () => FIXED_NOW,
        verifyPasswordStrict: () => Promise.reject(new Error('injected argon2 runtime failure')),
      },
      session,
      currentPassword: TEST_INITIAL_PASSWORD,
      newPassword: TEST_CHANGED_PASSWORD,
      requestId: 'strict-fail',
    });

    expect(response.statusCode).toBe(500);
    expect(response.body.error).toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred.',
    });

    const afterFailures = await currentApp()
      .database.db.select()
      .from(identitySecurityEvents)
      .where(eq(identitySecurityEvents.eventType, 'password_change_failed'));
    expect(afterFailures).toHaveLength(beforeFailures.length);

    const afterCredentials = await currentApp()
      .database.db.select()
      .from(accountPasswordCredentials)
      .where(eq(accountPasswordCredentials.accountId, registered.accountId));
    expect(afterCredentials).toEqual(beforeCredentials);

    const afterSessions = await currentApp()
      .database.db.select()
      .from(accountSessions)
      .where(eq(accountSessions.accountId, registered.accountId));
    expect(afterSessions).toEqual(beforeSessions);
  });

  it('concurrent successful password changes have exactly one winner', async () => {
    const email = 'Password.Change+concurrent-success@example.com';
    const registered = await registerActivePasskeyAccount(currentApp(), currentDelivery(), email);
    await signInWithPassword({
      app: currentApp(),
      email,
      clientType: 'mobile',
    });
    const sessions = await currentApp()
      .database.db.select()
      .from(accountSessions)
      .where(
        and(eq(accountSessions.accountId, registered.accountId), isNull(accountSessions.revokedAt)),
      );
    const session = sessions[0];
    if (session === undefined) {
      throw new Error('expected active session');
    }
    const originalCredential = await currentApp()
      .database.db.select()
      .from(accountPasswordCredentials)
      .where(
        and(
          eq(accountPasswordCredentials.accountId, registered.accountId),
          isNull(accountPasswordCredentials.revokedAt),
        ),
      );
    expect(originalCredential).toHaveLength(1);
    const originalCredentialId = originalCredential[0]?.id;
    if (originalCredentialId === undefined) {
      throw new Error('expected original credential');
    }

    const ready = createCountdownBarrier(2);
    const baseDeps = {
      env: currentEnv(),
      now: () => FIXED_NOW,
      beforeFinalTransaction: () => ready.arrive(),
    };

    const results = await Promise.allSettled([
      changeAccountPassword(currentApp().database.db, baseDeps, {
        session,
        currentPassword: TEST_INITIAL_PASSWORD,
        newPassword: TEST_CHANGED_PASSWORD,
        requestId: 'winner-or-loser-a',
      }),
      changeAccountPassword(currentApp().database.db, baseDeps, {
        session,
        currentPassword: TEST_INITIAL_PASSWORD,
        newPassword: TEST_CHANGED_PASSWORD_B,
        requestId: 'winner-or-loser-b',
      }),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const rejectedResult = rejected[0];
    if (rejectedResult?.status !== 'rejected') {
      throw new Error('expected one rejected concurrent change');
    }
    expect(rejectedResult.reason).toMatchObject({
      code: 'PASSWORD_CHANGE_FAILED',
      failureCategory: 'credential_race',
    });

    const active = await currentApp()
      .database.db.select()
      .from(accountPasswordCredentials)
      .where(
        and(
          eq(accountPasswordCredentials.accountId, registered.accountId),
          isNull(accountPasswordCredentials.revokedAt),
        ),
      );
    expect(active).toHaveLength(1);
    expect(active[0]?.id).not.toBe(originalCredentialId);

    const revokedOriginal = await currentApp()
      .database.db.select()
      .from(accountPasswordCredentials)
      .where(eq(accountPasswordCredentials.id, originalCredentialId));
    expect(revokedOriginal).toHaveLength(1);
    expect(revokedOriginal[0]?.revokedAt).not.toBeNull();

    const activeHash = active[0]?.passwordHash;
    if (activeHash === undefined) {
      throw new Error('expected winning hash');
    }
    const winnerIsA = await verifyPassword(TEST_CHANGED_PASSWORD, activeHash);
    const winnerIsB = await verifyPassword(TEST_CHANGED_PASSWORD_B, activeHash);
    expect(winnerIsA !== winnerIsB).toBe(true);
    expect(winnerIsA || winnerIsB).toBe(true);

    const raceFailures = await currentApp()
      .database.db.select()
      .from(identitySecurityEvents)
      .where(
        and(
          eq(identitySecurityEvents.accountId, registered.accountId),
          eq(identitySecurityEvents.eventType, 'password_change_failed'),
        ),
      );
    expect(
      raceFailures.some(
        (event) =>
          (event.metadata as { failureCategory?: string } | null)?.failureCategory ===
          'credential_race',
      ),
    ).toBe(true);
  });

  it('session logout during Argon2 verification prevents password change commit', async () => {
    const email = 'Password.Change+during-logout@example.com';
    const registered = await registerActivePasskeyAccount(currentApp(), currentDelivery(), email);
    await signInWithPassword({
      app: currentApp(),
      email,
      clientType: 'mobile',
    });
    const sessions = await currentApp()
      .database.db.select()
      .from(accountSessions)
      .where(
        and(eq(accountSessions.accountId, registered.accountId), isNull(accountSessions.revokedAt)),
      );
    const session = sessions[0];
    if (session === undefined) {
      throw new Error('expected active session');
    }
    const originalCredential = (
      await currentApp()
        .database.db.select()
        .from(accountPasswordCredentials)
        .where(
          and(
            eq(accountPasswordCredentials.accountId, registered.accountId),
            isNull(accountPasswordCredentials.revokedAt),
          ),
        )
    )[0];
    if (originalCredential === undefined) {
      throw new Error('expected credential');
    }

    const enteredVerify = createDeferred();
    const continueVerify = createDeferred();

    const changePromise = changeAccountPassword(
      currentApp().database.db,
      {
        env: currentEnv(),
        now: () => FIXED_NOW,
        verifyPasswordStrict: async (plaintext, storedHash) => {
          enteredVerify.resolve();
          await continueVerify.promise;
          return verifyPasswordStrict(plaintext, storedHash);
        },
      },
      {
        session,
        currentPassword: TEST_INITIAL_PASSWORD,
        newPassword: TEST_CHANGED_PASSWORD,
        requestId: 'during-logout',
      },
    );

    await enteredVerify.promise;
    await revokeAccountSession(currentApp().database.db, {
      sessionId: session.id,
      reason: 'logout',
      now: FIXED_NOW,
      eventId: '11111111-1111-4111-8111-111111111101',
      requestId: 'during-logout-revoke',
    });
    continueVerify.resolve();

    await expect(changePromise).rejects.toMatchObject({
      code: 'PASSWORD_CHANGE_FAILED',
      failureCategory: 'session_inactive',
    });

    const active = await currentApp()
      .database.db.select()
      .from(accountPasswordCredentials)
      .where(
        and(
          eq(accountPasswordCredentials.accountId, registered.accountId),
          isNull(accountPasswordCredentials.revokedAt),
        ),
      );
    expect(active).toHaveLength(1);
    expect(active[0]?.id).toBe(originalCredential.id);

    const successEvents = await currentApp()
      .database.db.select()
      .from(identitySecurityEvents)
      .where(
        and(
          eq(identitySecurityEvents.accountId, registered.accountId),
          eq(identitySecurityEvents.eventType, 'password_credential_changed'),
        ),
      );
    expect(successEvents).toHaveLength(0);

    const revoked = await currentApp()
      .database.db.select()
      .from(accountSessions)
      .where(eq(accountSessions.id, session.id));
    expect(revoked[0]?.revokedAt).not.toBeNull();
    expect(revoked[0]?.revocationReason).toBe('logout');
  });

  it('session rotation during Argon2 hashing prevents password change commit', async () => {
    const email = 'Password.Change+during-rotation@example.com';
    const registered = await registerActivePasskeyAccount(currentApp(), currentDelivery(), email);
    await signInWithPassword({
      app: currentApp(),
      email,
      clientType: 'mobile',
    });
    const sessions = await currentApp()
      .database.db.select()
      .from(accountSessions)
      .where(
        and(eq(accountSessions.accountId, registered.accountId), isNull(accountSessions.revokedAt)),
      );
    const session = sessions[0];
    if (session === undefined) {
      throw new Error('expected active session');
    }
    const originalCredential = (
      await currentApp()
        .database.db.select()
        .from(accountPasswordCredentials)
        .where(
          and(
            eq(accountPasswordCredentials.accountId, registered.accountId),
            isNull(accountPasswordCredentials.revokedAt),
          ),
        )
    )[0];
    if (originalCredential === undefined) {
      throw new Error('expected credential');
    }

    const enteredHash = createDeferred();
    const continueHash = createDeferred();
    const config = requirePasswordChangeConfig(currentEnv());

    const changePromise = changeAccountPassword(
      currentApp().database.db,
      {
        env: currentEnv(),
        now: () => FIXED_NOW,
        hashPassword: async (plaintext) => {
          enteredHash.resolve();
          await continueHash.promise;
          return hashPassword(plaintext);
        },
      },
      {
        session,
        currentPassword: TEST_INITIAL_PASSWORD,
        newPassword: TEST_CHANGED_PASSWORD,
        requestId: 'during-rotation',
      },
    );

    await enteredHash.promise;
    const replacementToken = generateSessionToken();
    const { replacement } = await rotateAccountSession(currentApp().database.db, {
      oldSessionId: session.id,
      newSessionId: '22222222-2222-4222-8222-222222222201',
      newTokenHash: hashSessionToken({
        hashKey: config.sessionTokenHashKey,
        clientType: 'mobile',
        token: replacementToken,
      }),
      now: FIXED_NOW,
      eventId: '22222222-2222-4222-8222-222222222202',
      requestId: 'during-rotation-rotate',
    });
    continueHash.resolve();

    await expect(changePromise).rejects.toMatchObject({
      code: 'PASSWORD_CHANGE_FAILED',
      failureCategory: 'session_inactive',
    });

    const active = await currentApp()
      .database.db.select()
      .from(accountPasswordCredentials)
      .where(
        and(
          eq(accountPasswordCredentials.accountId, registered.accountId),
          isNull(accountPasswordCredentials.revokedAt),
        ),
      );
    expect(active).toHaveLength(1);
    expect(active[0]?.id).toBe(originalCredential.id);

    const successEvents = await currentApp()
      .database.db.select()
      .from(identitySecurityEvents)
      .where(
        and(
          eq(identitySecurityEvents.accountId, registered.accountId),
          eq(identitySecurityEvents.eventType, 'password_credential_changed'),
        ),
      );
    expect(successEvents).toHaveLength(0);

    const oldSession = await currentApp()
      .database.db.select()
      .from(accountSessions)
      .where(eq(accountSessions.id, session.id));
    expect(oldSession[0]?.revocationReason).toBe('rotated');
    const activeSessions = await currentApp()
      .database.db.select()
      .from(accountSessions)
      .where(
        and(eq(accountSessions.accountId, registered.accountId), isNull(accountSessions.revokedAt)),
      );
    expect(activeSessions).toHaveLength(1);
    expect(activeSessions[0]?.id).toBe(replacement.id);
  });

  it('ordering: password change commits before sign-in credential recheck', async () => {
    const email = 'Password.Change+ordering-change-first@example.com';
    const registered = await registerActivePasskeyAccount(currentApp(), currentDelivery(), email);
    await signInWithPassword({
      app: currentApp(),
      email,
      clientType: 'mobile',
    });
    const sessions = await currentApp()
      .database.db.select()
      .from(accountSessions)
      .where(
        and(eq(accountSessions.accountId, registered.accountId), isNull(accountSessions.revokedAt)),
      );
    const session = sessions[0];
    if (session === undefined) {
      throw new Error('expected active session');
    }

    const locked = createDeferred();
    const proceed = createDeferred();
    const signInVerified = createDeferred();

    const changePromise = changeAccountPassword(
      currentApp().database.db,
      {
        env: currentEnv(),
        now: () => FIXED_NOW,
        afterCredentialLocked: async () => {
          locked.resolve();
          await proceed.promise;
        },
      },
      {
        session,
        currentPassword: TEST_INITIAL_PASSWORD,
        newPassword: TEST_CHANGED_PASSWORD,
        requestId: 'ordering-change-first',
      },
    );

    await locked.promise;

    const signInPromise = authenticateWithPassword(
      currentApp().database.db,
      {
        env: currentEnv(),
        now: () => FIXED_NOW,
        verifyPassword: async (plaintext, storedHash) => {
          const ok = await verifyPassword(plaintext, storedHash);
          signInVerified.resolve();
          return ok;
        },
      },
      {
        email,
        password: TEST_INITIAL_PASSWORD,
        clientType: 'mobile',
        ip: '127.0.0.71',
        requestId: 'ordering-sign-in',
      },
    );

    await signInVerified.promise;
    await waitForPostgresLockWait(currentPool());
    proceed.resolve();

    await expect(changePromise).resolves.toMatchObject({ status: 'PASSWORD_CHANGED' });
    await expect(signInPromise).rejects.toBeInstanceOf(AuthenticationFailedError);

    const activeSessions = await currentApp()
      .database.db.select()
      .from(accountSessions)
      .where(
        and(eq(accountSessions.accountId, registered.accountId), isNull(accountSessions.revokedAt)),
      );
    // Original session rotated by password change; failed sign-in creates no session.
    expect(activeSessions).toHaveLength(1);
    expect(activeSessions[0]?.id).not.toBe(session.id);

    const resignInOld = await signInWithPassword({
      app: currentApp(),
      email,
      password: TEST_INITIAL_PASSWORD,
      clientType: 'mobile',
    });
    expect(resignInOld.statusCode).toBe(400);
  });

  it('ordering: sign-in session created before password change is revoked', async () => {
    const email = 'Password.Change+ordering-signin-first@example.com';
    const registered = await registerActivePasskeyAccount(currentApp(), currentDelivery(), email);
    await signInWithPassword({
      app: currentApp(),
      email,
      clientType: 'mobile',
    });
    const sessions = await currentApp()
      .database.db.select()
      .from(accountSessions)
      .where(
        and(eq(accountSessions.accountId, registered.accountId), isNull(accountSessions.revokedAt)),
      );
    const session = sessions[0];
    if (session === undefined) {
      throw new Error('expected active session');
    }

    const readyForSignIn = createDeferred();
    const continueChange = createDeferred();

    const changePromise = changeAccountPassword(
      currentApp().database.db,
      {
        env: currentEnv(),
        now: () => FIXED_NOW,
        beforeFinalTransaction: async () => {
          readyForSignIn.resolve();
          await continueChange.promise;
        },
      },
      {
        session,
        currentPassword: TEST_INITIAL_PASSWORD,
        newPassword: TEST_CHANGED_PASSWORD,
        requestId: 'ordering-change-second',
      },
    );

    await readyForSignIn.promise;
    const sideSignIn = await authenticateWithPassword(
      currentApp().database.db,
      { env: currentEnv(), now: () => FIXED_NOW },
      {
        email,
        password: TEST_INITIAL_PASSWORD,
        clientType: 'mobile',
        ip: '127.0.0.72',
        requestId: 'ordering-side-sign-in',
      },
    );
    expect(sideSignIn.status).toBe('AUTHENTICATED');
    const sideToken = sideSignIn.rawToken;
    const sideSessionId = sideSignIn.session.id;

    continueChange.resolve();
    await expect(changePromise).resolves.toMatchObject({ status: 'PASSWORD_CHANGED' });

    const sideSession = await currentApp()
      .database.db.select()
      .from(accountSessions)
      .where(eq(accountSessions.id, sideSessionId));
    expect(sideSession[0]?.revokedAt).not.toBeNull();
    expect(sideSession[0]?.revocationReason).toBe('password_changed');

    const reuse = await changePasswordWithSession({
      app: currentApp(),
      sessionToken: sideToken,
      currentPassword: TEST_CHANGED_PASSWORD,
      newPassword: `${TEST_CHANGED_PASSWORD}-x`,
    });
    expect(reuse.statusCode).toBe(401);
  });

  it('unrelated CeremonyInvariantError remains INTERNAL_ERROR 500', async () => {
    const email = 'Password.Change+unrelated-invariant@example.com';
    const registered = await registerActivePasskeyAccount(currentApp(), currentDelivery(), email);
    await signInWithPassword({
      app: currentApp(),
      email,
      clientType: 'mobile',
    });
    const sessions = await currentApp()
      .database.db.select()
      .from(accountSessions)
      .where(
        and(eq(accountSessions.accountId, registered.accountId), isNull(accountSessions.revokedAt)),
      );
    const session = sessions[0];
    if (session === undefined) {
      throw new Error('expected active session');
    }
    const beforeCredentials = await currentApp()
      .database.db.select()
      .from(accountPasswordCredentials)
      .where(eq(accountPasswordCredentials.accountId, registered.accountId));
    const beforeSessions = await currentApp()
      .database.db.select()
      .from(accountSessions)
      .where(eq(accountSessions.accountId, registered.accountId));
    const beforeFailures = await currentApp()
      .database.db.select()
      .from(identitySecurityEvents)
      .where(eq(identitySecurityEvents.eventType, 'password_change_failed'));

    const response = await invokePasswordChangeThroughErrorHandler({
      db: currentApp().database.db,
      deps: {
        env: currentEnv(),
        now: () => FIXED_NOW,
        rotateAccountSessionTx: () =>
          Promise.reject(
            new CeremonyInvariantError('INVALID_RATE_LIMIT_SCOPE', 'Unrelated ceremony invariant'),
          ),
      },
      session,
      currentPassword: TEST_INITIAL_PASSWORD,
      newPassword: TEST_CHANGED_PASSWORD,
      requestId: 'unrelated-invariant',
    });

    expect(response.statusCode).toBe(500);
    expect(response.body.error).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(response.statusCode).not.toBe(400);

    const afterFailures = await currentApp()
      .database.db.select()
      .from(identitySecurityEvents)
      .where(eq(identitySecurityEvents.eventType, 'password_change_failed'));
    expect(afterFailures).toHaveLength(beforeFailures.length);

    const afterCredentials = await currentApp()
      .database.db.select()
      .from(accountPasswordCredentials)
      .where(eq(accountPasswordCredentials.accountId, registered.accountId));
    expect(afterCredentials).toEqual(beforeCredentials);

    const afterSessions = await currentApp()
      .database.db.select()
      .from(accountSessions)
      .where(eq(accountSessions.accountId, registered.accountId));
    expect(afterSessions).toEqual(beforeSessions);
  });

  it('forced mid-transaction rollback leaves credentials and sessions unchanged', async () => {
    const email = 'Password.Change+rollback@example.com';
    const registered = await registerActivePasskeyAccount(currentApp(), currentDelivery(), email);
    const first = await signInWithPassword({
      app: currentApp(),
      email,
      clientType: 'mobile',
    });
    const second = await signInWithPassword({
      app: currentApp(),
      email,
      clientType: 'mobile',
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const firstToken = first.json<{ data: { sessionToken: string } }>().data.sessionToken;
    const secondToken = second.json<{ data: { sessionToken: string } }>().data.sessionToken;

    const config = requirePasswordChangeConfig(currentEnv());
    const firstHash = hashSessionToken({
      hashKey: config.sessionTokenHashKey,
      clientType: 'mobile',
      token: firstToken,
    });
    const sessionRows = await currentApp()
      .database.db.select()
      .from(accountSessions)
      .where(
        and(eq(accountSessions.accountId, registered.accountId), isNull(accountSessions.revokedAt)),
      );
    expect(sessionRows).toHaveLength(2);
    const session = sessionRows.find((row) => Buffer.compare(row.tokenHash, firstHash) === 0);
    if (session === undefined) {
      throw new Error('expected session matching first token');
    }

    const beforeCredentials = await currentApp()
      .database.db.select()
      .from(accountPasswordCredentials)
      .where(eq(accountPasswordCredentials.accountId, registered.accountId));
    const beforeSessions = await currentApp()
      .database.db.select()
      .from(accountSessions)
      .where(eq(accountSessions.accountId, registered.accountId));
    const beforeSuccess = await currentApp()
      .database.db.select()
      .from(identitySecurityEvents)
      .where(
        and(
          eq(identitySecurityEvents.accountId, registered.accountId),
          eq(identitySecurityEvents.eventType, 'password_credential_changed'),
        ),
      );
    const beforeRotated = await currentApp()
      .database.db.select()
      .from(identitySecurityEvents)
      .where(
        and(
          eq(identitySecurityEvents.accountId, registered.accountId),
          eq(identitySecurityEvents.eventType, 'session_rotated'),
        ),
      );
    const beforeRevoked = await currentApp()
      .database.db.select()
      .from(identitySecurityEvents)
      .where(
        and(
          eq(identitySecurityEvents.accountId, registered.accountId),
          eq(identitySecurityEvents.eventType, 'session_revoked'),
        ),
      );

    const response = await invokePasswordChangeThroughErrorHandler({
      db: currentApp().database.db,
      deps: {
        env: currentEnv(),
        now: () => FIXED_NOW,
        afterCredentialMutation: () =>
          Promise.reject(new Error('injected mid-transaction failure')),
      },
      session,
      currentPassword: TEST_INITIAL_PASSWORD,
      newPassword: TEST_CHANGED_PASSWORD,
      requestId: 'rollback',
    });
    expect(response.statusCode).toBe(500);
    expect(response.body.error).toMatchObject({ code: 'INTERNAL_ERROR' });

    const afterCredentials = await currentApp()
      .database.db.select()
      .from(accountPasswordCredentials)
      .where(eq(accountPasswordCredentials.accountId, registered.accountId));
    expect(afterCredentials).toEqual(beforeCredentials);
    expect(afterCredentials.filter((row) => row.revokedAt === null)).toHaveLength(1);

    const afterSessions = await currentApp()
      .database.db.select()
      .from(accountSessions)
      .where(eq(accountSessions.accountId, registered.accountId));
    expect(afterSessions).toEqual(beforeSessions);

    const afterSuccess = await currentApp()
      .database.db.select()
      .from(identitySecurityEvents)
      .where(
        and(
          eq(identitySecurityEvents.accountId, registered.accountId),
          eq(identitySecurityEvents.eventType, 'password_credential_changed'),
        ),
      );
    expect(afterSuccess).toHaveLength(beforeSuccess.length);

    const afterRotated = await currentApp()
      .database.db.select()
      .from(identitySecurityEvents)
      .where(
        and(
          eq(identitySecurityEvents.accountId, registered.accountId),
          eq(identitySecurityEvents.eventType, 'session_rotated'),
        ),
      );
    expect(afterRotated).toHaveLength(beforeRotated.length);

    const afterRevoked = await currentApp()
      .database.db.select()
      .from(identitySecurityEvents)
      .where(
        and(
          eq(identitySecurityEvents.accountId, registered.accountId),
          eq(identitySecurityEvents.eventType, 'session_revoked'),
        ),
      );
    expect(afterRevoked).toHaveLength(beforeRevoked.length);

    const reuseFirst = await changePasswordWithSession({
      app: currentApp(),
      sessionToken: firstToken,
      currentPassword: TEST_INITIAL_PASSWORD,
      newPassword: TEST_CHANGED_PASSWORD,
    });
    expect(reuseFirst.statusCode).toBe(200);

    const reuseSecond = await changePasswordWithSession({
      app: currentApp(),
      sessionToken: secondToken,
      currentPassword: TEST_CHANGED_PASSWORD,
      newPassword: `${TEST_CHANGED_PASSWORD}-again`,
    });
    // Second session was revoked by the successful change above.
    expect(reuseSecond.statusCode).toBe(401);
  });
});

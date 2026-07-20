import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { count, eq, isNull } from 'drizzle-orm';
import type { AppInstance } from '../src/app.js';
import {
  accountSessions,
  actors,
  identitySecurityEvents,
  passkeyCredentials,
  signalConfirmations,
  webauthnChallenges,
} from '../src/db/schema.js';
import { CONTROLLED_TEST_ACTOR_ID } from '../src/db/seeds/controlled-actor-content.js';
import { toIsoTimestamp } from '../src/lib/timestamps.js';
import {
  authenticatePasskey,
  createPasskeyAuthenticationTestApp,
  registerActivePasskeyAccount,
  TEST_ANONYMOUS_CLIENT_KEY,
  TEST_ORIGIN,
  TEST_RP_ID,
  TEST_WEB_SESSION_COOKIE_NAME,
} from './helpers/passkey-authentication.js';

const FIXED_NOW = '2026-07-16T14:00:00.000Z';
const FAILURE_BODY = {
  error: {
    code: 'AUTHENTICATION_FAILED',
    message: 'Authentication could not be completed.',
  },
};

type OptionsJson = {
  data: {
    authenticationCeremonyId: string;
    options: {
      challenge: string;
      allowCredentials?: unknown[];
      userVerification: string;
      timeout: number;
      rpId: string;
    };
  };
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

describe('passkey authentication runtime API', () => {
  let app: AppInstance | undefined;
  let pool: Awaited<ReturnType<typeof createPasskeyAuthenticationTestApp>>['pool'] | undefined;
  let delivery:
    Awaited<ReturnType<typeof createPasskeyAuthenticationTestApp>>['delivery'] | undefined;
  let nowMs = Date.parse(FIXED_NOW);

  async function boot(options?: Parameters<typeof createPasskeyAuthenticationTestApp>[0]) {
    if (app !== undefined) {
      await app.close();
    }
    if (pool !== undefined) {
      await pool.end();
    }
    nowMs = Date.parse(FIXED_NOW);
    const created = await createPasskeyAuthenticationTestApp({
      now: () => new Date(nowMs).toISOString(),
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

  function currentDelivery(): NonNullable<typeof delivery> {
    if (delivery === undefined) {
      throw new Error('delivery not ready');
    }
    return delivery;
  }

  async function countRows(table: typeof accountSessions | typeof webauthnChallenges) {
    return (await currentApp().database.db.select({ value: count() }).from(table))[0]?.value ?? 0;
  }

  it('defaults disabled feature to safe not-found', async () => {
    await boot({ enabled: false });

    const response = await currentApp().inject({
      method: 'POST',
      url: '/v1/authentication/passkeys/options',
      payload: { clientType: 'web', anonymousClientKey: TEST_ANONYMOUS_CLIENT_KEY },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: {
        code: 'NOT_FOUND',
        message: 'Not Found.',
      },
    });
  });

  it('creates authentication options without allowCredentials and with required UV', async () => {
    const response = await currentApp().inject({
      method: 'POST',
      url: '/v1/authentication/passkeys/options',
      payload: { clientType: 'web', anonymousClientKey: TEST_ANONYMOUS_CLIENT_KEY },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<OptionsJson>();
    expect(body.data.authenticationCeremonyId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(body.data.options.rpId).toBe(TEST_RP_ID);
    expect(body.data.options.userVerification).toBe('required');
    expect(body.data.options.allowCredentials).toBeUndefined();
    expect(body.data.options.timeout).toBe(300_000);

    const challenge = (
      await currentApp()
        .database.db.select()
        .from(webauthnChallenges)
        .where(eq(webauthnChallenges.id, body.data.authenticationCeremonyId))
    )[0];
    expect(challenge?.accountId).toBeNull();
    expect(challenge?.purpose).toBe('authenticate');
    expect(challenge?.challengeHash.length).toBeGreaterThan(0);
  });

  it('rate limits authentication options for one anonymous client', async () => {
    for (let index = 0; index < 10; index += 1) {
      const response = await currentApp().inject({
        method: 'POST',
        url: '/v1/authentication/passkeys/options',
        remoteAddress: '127.0.0.10',
        payload: { clientType: 'web', anonymousClientKey: 'rate-limit-client-0001' },
      });
      expect(response.statusCode).toBe(200);
    }

    const limited = await currentApp().inject({
      method: 'POST',
      url: '/v1/authentication/passkeys/options',
      remoteAddress: '127.0.0.10',
      payload: { clientType: 'web', anonymousClientKey: 'rate-limit-client-0001' },
    });
    expect(limited.statusCode).toBe(400);
    expect(limited.json()).toMatchObject(FAILURE_BODY);
  });

  it('verifies valid web authentication, sets cookie attributes, and preserves controlled actor', async () => {
    const registered = await registerActivePasskeyAccount(
      currentApp(),
      currentDelivery(),
      'Web.Auth+passkey@example.com',
    );

    const { verifyResponse } = await authenticatePasskey({
      app: currentApp(),
      material: registered.material,
      clientType: 'web',
      signCount: 1,
      userHandle: registered.userHandle,
    });

    expect(verifyResponse.statusCode).toBe(200);
    expect(verifyResponse.json()).toEqual({ data: { status: 'AUTHENTICATED' } });
    const cookie = setCookieHeaders(verifyResponse)[0] ?? '';
    expect(cookie).toContain(`${TEST_WEB_SESSION_COOKIE_NAME}=`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Max-Age=86400');
    expect(cookie).not.toContain('Domain=');
    expect(JSON.stringify(verifyResponse.json())).not.toContain('sessionToken');

    const session = (await currentApp().database.db.select().from(accountSessions))[0];
    expect(session?.accountId).toBe(registered.accountId);
    expect(session?.clientType).toBe('web');
    expect(session?.revokedAt).toBeNull();

    const credential = (await currentApp().database.db.select().from(passkeyCredentials))[0];
    expect(credential?.signCount).toBe(1);
    expect(credential?.backupEligible).toBe(true);
    expect(credential?.backedUp).toBe(true);

    expect(
      (
        await currentApp()
          .database.db.select()
          .from(actors)
          .where(eq(actors.id, CONTROLLED_TEST_ACTOR_ID))
      )[0]?.accountId,
    ).toBeNull();
    expect(
      (await currentApp().database.db.select({ value: count() }).from(signalConfirmations))[0]
        ?.value,
    ).toBe(0);
  });

  it('verifies valid mobile authentication and accepts only Authorization: Session for mobile', async () => {
    const registered = await registerActivePasskeyAccount(
      currentApp(),
      currentDelivery(),
      'Mobile.Auth+passkey@example.com',
    );

    const { verifyResponse } = await authenticatePasskey({
      app: currentApp(),
      material: registered.material,
      clientType: 'mobile',
      signCount: 1,
      userHandle: registered.userHandle,
    });

    expect(verifyResponse.statusCode).toBe(200);
    const body = verifyResponse.json<{
      data: { status: string; sessionToken: string; sessionExpiresAt: string };
    }>();
    expect(body.data.status).toBe('AUTHENTICATED');
    expect(body.data.sessionToken).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(toIsoTimestamp(body.data.sessionExpiresAt)).toBe('2026-07-17T14:00:00.000Z');
    expect(setCookieHeaders(verifyResponse)).toHaveLength(0);

    const session = await currentApp().inject({
      method: 'GET',
      url: '/v1/authentication/session',
      headers: { authorization: `Session ${body.data.sessionToken}` },
    });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({
      data: { authenticated: true, clientType: 'mobile', sensitiveOperationsFresh: true },
    });
  });

  it('rejects counter anomalies, missing UV, and wrong origin with generic failures', async () => {
    const counter = await registerActivePasskeyAccount(
      currentApp(),
      currentDelivery(),
      'Counter.Auth+passkey@example.com',
    );
    expect(
      (
        await authenticatePasskey({
          app: currentApp(),
          material: counter.material,
          clientType: 'web',
          signCount: 1,
        })
      ).verifyResponse.statusCode,
    ).toBe(200);

    const anomaly = await authenticatePasskey({
      app: currentApp(),
      material: counter.material,
      clientType: 'web',
      signCount: 1,
    });
    expect(anomaly.verifyResponse.statusCode).toBe(400);
    expect(anomaly.verifyResponse.json()).toMatchObject(FAILURE_BODY);
    expect(
      (
        await currentApp()
          .database.db.select({ value: count() })
          .from(identitySecurityEvents)
          .where(eq(identitySecurityEvents.eventType, 'counter_anomaly_detected'))
      )[0]?.value,
    ).toBeGreaterThanOrEqual(1);

    await boot();
    const noUv = await registerActivePasskeyAccount(
      currentApp(),
      currentDelivery(),
      'No.Uv.Auth+passkey@example.com',
    );
    const uvMissing = await authenticatePasskey({
      app: currentApp(),
      material: noUv.material,
      clientType: 'web',
      signCount: 1,
      userVerified: false,
    });
    expect(uvMissing.verifyResponse.statusCode).toBe(400);
    expect(uvMissing.verifyResponse.json()).toMatchObject(FAILURE_BODY);

    await boot();
    const wrongOrigin = await registerActivePasskeyAccount(
      currentApp(),
      currentDelivery(),
      'Wrong.Origin.Auth+passkey@example.com',
    );
    const failed = await authenticatePasskey({
      app: currentApp(),
      material: wrongOrigin.material,
      clientType: 'web',
      signCount: 1,
      origin: 'http://localhost:4000',
    });
    expect(failed.verifyResponse.statusCode).toBe(400);
    expect(failed.verifyResponse.json()).toMatchObject(FAILURE_BODY);
    expect(await countRows(accountSessions)).toBe(0);
  });

  it('introspects, touches, rotates, and logs out a web session', async () => {
    const registered = await registerActivePasskeyAccount(
      currentApp(),
      currentDelivery(),
      'Lifecycle.Auth+passkey@example.com',
    );
    const { verifyResponse } = await authenticatePasskey({
      app: currentApp(),
      material: registered.material,
      clientType: 'web',
      signCount: 1,
    });
    const cookie = sessionCookieFrom(verifyResponse);

    const initial = await currentApp().inject({
      method: 'GET',
      url: '/v1/authentication/session',
      headers: { cookie },
    });
    expect(initial.json()).toMatchObject({
      data: { authenticated: true, clientType: 'web', sensitiveOperationsFresh: true },
    });
    const beforeTouch = (await currentApp().database.db.select().from(accountSessions))[0];

    nowMs += 6 * 60_000;
    const touched = await currentApp().inject({
      method: 'GET',
      url: '/v1/authentication/session',
      headers: { cookie },
    });
    expect(touched.statusCode).toBe(200);
    const afterTouch = (
      await currentApp()
        .database.db.select()
        .from(accountSessions)
        .where(isNull(accountSessions.revokedAt))
    )[0];
    expect(new Date(afterTouch?.lastSeenAt ?? '').getTime()).toBeGreaterThan(
      new Date(beforeTouch?.lastSeenAt ?? '').getTime(),
    );

    const rotated = await currentApp().inject({
      method: 'POST',
      url: '/v1/authentication/session/rotate',
      headers: { cookie, origin: TEST_ORIGIN },
    });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json()).toEqual({ data: { status: 'AUTHENTICATED' } });
    const rotatedCookie = sessionCookieFrom(rotated);
    expect(rotatedCookie).not.toBe(cookie);

    const oldSession = await currentApp().inject({
      method: 'GET',
      url: '/v1/authentication/session',
      headers: { cookie },
    });
    expect(oldSession.json()).toEqual({ data: { authenticated: false } });

    const activeSession = await currentApp().inject({
      method: 'GET',
      url: '/v1/authentication/session',
      headers: { cookie: rotatedCookie },
    });
    expect(activeSession.json()).toMatchObject({ data: { authenticated: true } });

    const logout = await currentApp().inject({
      method: 'POST',
      url: '/v1/authentication/logout',
      headers: { cookie: rotatedCookie, origin: TEST_ORIGIN },
    });
    expect(logout.statusCode).toBe(200);
    expect(logout.json()).toEqual({ data: { status: 'SIGNED_OUT' } });
    expect(setCookieHeaders(logout).join('\n')).toContain(`${TEST_WEB_SESSION_COOKIE_NAME}=`);
    expect(
      (
        await currentApp()
          .database.db.select()
          .from(accountSessions)
          .where(isNull(accountSessions.revokedAt))
      ).length,
    ).toBe(0);
  });

  it('requires CSRF evidence for mutative web-cookie session routes', async () => {
    const registered = await registerActivePasskeyAccount(
      currentApp(),
      currentDelivery(),
      'Csrf.Auth+passkey@example.com',
    );
    const { verifyResponse } = await authenticatePasskey({
      app: currentApp(),
      material: registered.material,
      clientType: 'web',
      signCount: 1,
    });
    const cookie = sessionCookieFrom(verifyResponse);

    const response = await currentApp().inject({
      method: 'POST',
      url: '/v1/authentication/session/rotate',
      headers: { cookie, origin: 'http://localhost:4000' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject(FAILURE_BODY);
  });

  it('enforces logout-all freshness and revokes all fresh sessions', async () => {
    const stale = await registerActivePasskeyAccount(
      currentApp(),
      currentDelivery(),
      'Stale.Auth+passkey@example.com',
    );
    const staleAuth = await authenticatePasskey({
      app: currentApp(),
      material: stale.material,
      clientType: 'web',
      signCount: 1,
    });
    nowMs += 11 * 60_000;
    const staleLogoutAll = await currentApp().inject({
      method: 'POST',
      url: '/v1/authentication/logout-all',
      headers: { cookie: sessionCookieFrom(staleAuth.verifyResponse), origin: TEST_ORIGIN },
    });
    expect(staleLogoutAll.statusCode).toBe(401);
    expect(staleLogoutAll.json()).toMatchObject({
      error: { code: 'RECENT_AUTHENTICATION_REQUIRED' },
    });

    await boot();
    const fresh = await registerActivePasskeyAccount(
      currentApp(),
      currentDelivery(),
      'Fresh.Auth+passkey@example.com',
    );
    const web = await authenticatePasskey({
      app: currentApp(),
      material: fresh.material,
      clientType: 'web',
      signCount: 1,
    });
    const mobile = await authenticatePasskey({
      app: currentApp(),
      material: fresh.material,
      clientType: 'mobile',
      signCount: 2,
    });
    expect(web.verifyResponse.statusCode).toBe(200);
    expect(mobile.verifyResponse.statusCode).toBe(200);

    const logoutAll = await currentApp().inject({
      method: 'POST',
      url: '/v1/authentication/logout-all',
      headers: { cookie: sessionCookieFrom(web.verifyResponse), origin: TEST_ORIGIN },
    });
    expect(logoutAll.statusCode).toBe(200);
    expect(logoutAll.json()).toEqual({ data: { status: 'SIGNED_OUT' } });
    expect(
      (
        await currentApp()
          .database.db.select()
          .from(accountSessions)
          .where(isNull(accountSessions.revokedAt))
      ).length,
    ).toBe(0);
  });

  it('allows exactly one concurrent verify for one authentication challenge', async () => {
    const registered = await registerActivePasskeyAccount(
      currentApp(),
      currentDelivery(),
      'Concurrent.Auth+passkey@example.com',
    );
    const optionsResponse = await currentApp().inject({
      method: 'POST',
      url: '/v1/authentication/passkeys/options',
      payload: { clientType: 'web', anonymousClientKey: TEST_ANONYMOUS_CLIENT_KEY },
    });
    const options = optionsResponse.json<OptionsJson>();
    const payload = {
      authenticationCeremonyId: options.data.authenticationCeremonyId,
      clientType: 'web',
      response: registered.material.createAuthenticationResponse({
        challenge: options.data.options.challenge,
        rpID: TEST_RP_ID,
        origin: TEST_ORIGIN,
        signCount: 1,
      }),
    };

    const results = await Promise.all(
      [0, 1].map(() =>
        currentApp().inject({
          method: 'POST',
          url: '/v1/authentication/passkeys/verify',
          payload,
        }),
      ),
    );

    expect(results.filter((response) => response.statusCode === 200)).toHaveLength(1);
    expect(results.filter((response) => response.statusCode === 400)).toHaveLength(1);
    expect(await countRows(accountSessions)).toBe(1);
  });
});

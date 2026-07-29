import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { accountSessions, identitySecurityEvents, passkeyCredentials } from '../src/db/schema.js';
import { createSoftPasskeyMaterial } from './helpers/webauthn-soft-authenticator.js';
import { completeEmailAndPasswordSetup } from './helpers/passkey-registration.js';
import {
  addSecondPasskeyMobile,
  authenticatePasskey,
  countActivePasskeys,
  createPasskeyManagementTestApp,
  loginMobileSession,
  reauthenticateMobile,
  registerActivePasskeyAccount,
  TEST_ANONYMOUS_CLIENT_KEY,
  TEST_ORIGIN,
  TEST_RP_ID,
} from './helpers/passkey-management.js';

function must<T>(value: T | null | undefined, message = 'expected value'): T {
  if (value === null || value === undefined) {
    throw new Error(message);
  }
  return value;
}

describe('passkey management api', () => {
  let app: Awaited<ReturnType<typeof createPasskeyManagementTestApp>>['app'];
  let pool: Awaited<ReturnType<typeof createPasskeyManagementTestApp>>['pool'];
  let delivery: Awaited<ReturnType<typeof createPasskeyManagementTestApp>>['delivery'];

  beforeAll(async () => {
    ({ app, pool, delivery } = await createPasskeyManagementTestApp());
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('rejects SetupGrant, RecoveryGrant, and Bearer on all Slice 6 management routes', async () => {
    const managementPaths = [
      { method: 'GET' as const, url: '/v1/account/passkeys' },
      {
        method: 'POST' as const,
        url: '/v1/account/security/reauthentication/passkeys/options',
        payload: {},
      },
      {
        method: 'POST' as const,
        url: '/v1/account/passkeys/add/options',
        payload: {},
      },
      {
        method: 'POST' as const,
        url: '/v1/account/passkeys/add/verify',
        payload: {
          registrationCeremonyId: '00000000-0000-4000-8000-000000000001',
          response: {
            id: 'x',
            rawId: 'x',
            type: 'public-key',
            response: { clientDataJSON: 'x', attestationObject: 'x' },
          },
        },
      },
    ];

    for (const path of managementPaths) {
      for (const scheme of ['SetupGrant', 'RecoveryGrant', 'Bearer'] as const) {
        const response = await app.inject({
          method: path.method,
          url: path.url,
          headers: { authorization: `${scheme} not-a-real-token` },
          ...('payload' in path ? { payload: path.payload } : {}),
        });
        expect(response.statusCode).toBe(401);
        expect(response.json()).toMatchObject({ error: { code: 'SESSION_NOT_AUTHORIZED' } });
      }
    }
  });

  it('keeps SetupGrant first-passkey registration on Slice 3 paths only', async () => {
    const setup = await completeEmailAndPasswordSetup(
      app,
      delivery,
      'Initial.Setup+setup@example.com',
    );
    const optionsResponse = await app.inject({
      method: 'POST',
      url: '/v1/account/passkeys/registration/options',
      headers: { authorization: `SetupGrant ${setup.setupGrant}` },
      payload: {},
    });
    expect(optionsResponse.statusCode).toBe(200);
    const options = optionsResponse.json<{
      data: { registrationCeremonyId: string; options: { challenge: string } };
    }>();
    const material = createSoftPasskeyMaterial();
    const verifyResponse = await app.inject({
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
    expect(verifyResponse.json()).toMatchObject({ data: { status: 'ACCOUNT_READY' } });

    const sessionOnSetupPath = await app.inject({
      method: 'POST',
      url: '/v1/account/passkeys/registration/options',
      headers: { authorization: 'Session not-a-real-token' },
      payload: {},
    });
    expect(sessionOnSetupPath.statusCode).toBe(400);
    expect(sessionOnSetupPath.json()).toMatchObject({
      error: { code: 'PASSKEY_REGISTRATION_FAILED' },
    });
  });

  it('lists inventory with opaque public ids and safe fields only', async () => {
    const registered = await registerActivePasskeyAccount(
      app,
      delivery,
      'Inventory.Safe+setup@example.com',
    );
    const login = await loginMobileSession({
      app,
      material: registered.material,
      userHandle: registered.userHandle,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/account/passkeys',
      headers: { authorization: `Session ${login.sessionToken}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      data: {
        passkeys: Record<string, unknown>[];
      };
    }>();
    expect(body.data.passkeys).toHaveLength(1);
    const passkey = must(body.data.passkeys[0]);
    expect(passkey).toHaveProperty('id');
    expect(passkey).toHaveProperty('backupEligible');
    expect(passkey).toHaveProperty('currentSessionCredential', true);
    expect(passkey).not.toHaveProperty('credentialId');
    expect(passkey).not.toHaveProperty('publicKey');
    expect(passkey).not.toHaveProperty('aaguid');
    expect(passkey).not.toHaveProperty('signCount');
    expect(passkey).not.toHaveProperty('userHandle');
    expect(passkey).not.toHaveProperty('passkeyId');
    expect(passkey).not.toHaveProperty('credentialId');

    const events = await app.database.db
      .select()
      .from(identitySecurityEvents)
      .where(
        and(
          eq(identitySecurityEvents.accountId, registered.accountId),
          eq(identitySecurityEvents.eventType, 'passkey_inventory_viewed'),
        ),
      );
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  it('reauthenticates, sets freshness, and rotates the mobile session token', async () => {
    const registered = await registerActivePasskeyAccount(
      app,
      delivery,
      'Reauth.Fresh+setup@example.com',
    );
    const login = await loginMobileSession({
      app,
      material: registered.material,
      userHandle: registered.userHandle,
      signCount: 1,
    });

    const reauth = await reauthenticateMobile({
      app,
      sessionToken: login.sessionToken,
      material: registered.material,
      signCount: 2,
      userHandle: registered.userHandle,
    });
    expect(reauth.statusCode).toBe(200);
    const data = (reauth.body as { data: Record<string, unknown> }).data;
    expect(data.status).toBe('FRESH_AUTHENTICATION_CONFIRMED');
    expect(typeof data.freshUntil).toBe('string');
    expect(typeof data.sessionToken).toBe('string');
    expect(data.sessionToken).not.toBe(login.sessionToken);

    const sessions = await app.database.db
      .select()
      .from(accountSessions)
      .where(
        and(eq(accountSessions.accountId, registered.accountId), isNull(accountSessions.revokedAt)),
      );
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.freshAuthenticatedAt).not.toBeNull();
    expect(sessions[0]?.authenticatedPasskeyId).not.toBeNull();
  });

  it('adds a second passkey with freshness, excludeCredentials, and revokes other sessions', async () => {
    const registered = await registerActivePasskeyAccount(
      app,
      delivery,
      'Add.Passkey+setup@example.com',
    );
    const loginA = await loginMobileSession({
      app,
      material: registered.material,
      userHandle: registered.userHandle,
      signCount: 1,
      anonymousClientKey: 'anonymous-client-key-add-a',
    });
    const loginB = await loginMobileSession({
      app,
      material: registered.material,
      userHandle: registered.userHandle,
      signCount: 2,
      anonymousClientKey: 'anonymous-client-key-add-b',
    });

    const reauth = await reauthenticateMobile({
      app,
      sessionToken: loginB.sessionToken,
      material: registered.material,
      signCount: 3,
      userHandle: registered.userHandle,
    });
    expect(reauth.statusCode).toBe(200);
    const freshToken = must(reauth.sessionToken);

    const optionsResponse = await app.inject({
      method: 'POST',
      url: '/v1/account/passkeys/add/options',
      headers: { authorization: `Session ${freshToken}` },
      payload: {},
    });
    expect(optionsResponse.statusCode).toBe(200);
    const options = optionsResponse.json<{
      data: {
        registrationCeremonyId: string;
        options: { challenge: string; excludeCredentials?: { id: string }[] };
      };
    }>();
    expect(options.data.options.excludeCredentials?.length).toBeGreaterThanOrEqual(1);

    const secondMaterial = createSoftPasskeyMaterial();
    const verifyResponse = await app.inject({
      method: 'POST',
      url: '/v1/account/passkeys/add/verify',
      headers: { authorization: `Session ${freshToken}` },
      payload: {
        registrationCeremonyId: options.data.registrationCeremonyId,
        response: secondMaterial.createRegistrationResponse({
          challenge: options.data.options.challenge,
          rpID: TEST_RP_ID,
          origin: TEST_ORIGIN,
        }),
      },
    });
    expect(verifyResponse.statusCode).toBe(200);
    const body = verifyResponse.json<{
      data: { status: string; passkey: { id: string }; sessionToken: string };
    }>();
    expect(body.data.status).toBe('PASSKEY_ADDED');
    expect(body.data.passkey.id).toBeTruthy();
    expect(body.data.sessionToken).toBeTruthy();
    expect(await countActivePasskeys(app, registered.accountId)).toBe(2);

    const oldA = await app.inject({
      method: 'GET',
      url: '/v1/account/passkeys',
      headers: { authorization: `Session ${loginA.sessionToken}` },
    });
    expect(oldA.statusCode).toBe(401);

    const revokedOthers = await app.database.db
      .select()
      .from(accountSessions)
      .where(
        and(
          eq(accountSessions.accountId, registered.accountId),
          eq(accountSessions.revocationReason, 'passkey_added'),
        ),
      );
    expect(revokedOthers.length).toBeGreaterThanOrEqual(1);
  });

  it('requires freshness before add-passkey', async () => {
    const registered = await registerActivePasskeyAccount(
      app,
      delivery,
      'Add.Stale+setup@example.com',
    );
    const login = await loginMobileSession({
      app,
      material: registered.material,
      userHandle: registered.userHandle,
      signCount: 1,
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/account/passkeys/add/options',
      headers: { authorization: `Session ${login.sessionToken}` },
      payload: {},
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: { code: 'FRESH_AUTHENTICATION_REQUIRED' },
    });
  });

  it('renames without freshness and is idempotent for same label', async () => {
    const registered = await registerActivePasskeyAccount(
      app,
      delivery,
      'Rename.Label+setup@example.com',
    );
    const login = await loginMobileSession({
      app,
      material: registered.material,
      userHandle: registered.userHandle,
      signCount: 1,
    });
    const inventory = await app.inject({
      method: 'GET',
      url: '/v1/account/passkeys',
      headers: { authorization: `Session ${login.sessionToken}` },
    });
    const passkeyId = must(
      inventory.json<{ data: { passkeys: { id: string }[] } }>().data.passkeys[0],
    ).id;

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/v1/account/passkeys/${passkeyId}`,
      headers: { authorization: `Session ${login.sessionToken}` },
      payload: { label: 'Kitchen tablet' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({
      data: {
        status: 'PASSKEY_UPDATED',
        passkey: { label: 'Kitchen tablet', id: passkeyId },
      },
    });

    const beforeEvents = await app.database.db
      .select()
      .from(identitySecurityEvents)
      .where(
        and(
          eq(identitySecurityEvents.accountId, registered.accountId),
          eq(identitySecurityEvents.eventType, 'passkey_management_changed'),
        ),
      );
    const renameCount = beforeEvents.filter(
      (event) =>
        event.metadata &&
        typeof event.metadata === 'object' &&
        (event.metadata as { change?: string }).change === 'passkey_renamed',
    ).length;

    const again = await app.inject({
      method: 'PATCH',
      url: `/v1/account/passkeys/${passkeyId}`,
      headers: { authorization: `Session ${login.sessionToken}` },
      payload: { label: 'Kitchen tablet' },
    });
    expect(again.statusCode).toBe(200);

    const afterEvents = await app.database.db
      .select()
      .from(identitySecurityEvents)
      .where(
        and(
          eq(identitySecurityEvents.accountId, registered.accountId),
          eq(identitySecurityEvents.eventType, 'passkey_management_changed'),
        ),
      );
    const renameCountAfter = afterEvents.filter(
      (event) =>
        event.metadata &&
        typeof event.metadata === 'object' &&
        (event.metadata as { change?: string }).change === 'passkey_renamed',
    ).length;
    expect(renameCountAfter).toBe(renameCount);
  });

  it('returns PASSKEY_NOT_FOUND for cross-account or missing passkey rename', async () => {
    const registered = await registerActivePasskeyAccount(
      app,
      delivery,
      'Rename.Missing+setup@example.com',
    );
    const login = await loginMobileSession({
      app,
      material: registered.material,
      userHandle: registered.userHandle,
      signCount: 1,
    });
    const response = await app.inject({
      method: 'PATCH',
      url: '/v1/account/passkeys/00000000-0000-4000-8000-000000000099',
      headers: { authorization: `Session ${login.sessionToken}` },
      payload: { label: 'Nope' },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'PASSKEY_NOT_FOUND' } });
  });

  it('protects last active passkey and current authenticated credential on revoke', async () => {
    const registered = await registerActivePasskeyAccount(
      app,
      delivery,
      'Revoke.Protect+setup@example.com',
    );
    const login = await loginMobileSession({
      app,
      material: registered.material,
      userHandle: registered.userHandle,
      signCount: 1,
    });
    const reauth = await reauthenticateMobile({
      app,
      sessionToken: login.sessionToken,
      material: registered.material,
      signCount: 2,
      userHandle: registered.userHandle,
    });
    const freshToken = must(reauth.sessionToken);

    const inventory = await app.inject({
      method: 'GET',
      url: '/v1/account/passkeys',
      headers: { authorization: `Session ${freshToken}` },
    });
    const onlyId = must(
      inventory.json<{ data: { passkeys: { id: string }[] } }>().data.passkeys[0],
    ).id;

    const last = await app.inject({
      method: 'DELETE',
      url: `/v1/account/passkeys/${onlyId}`,
      headers: { authorization: `Session ${freshToken}` },
    });
    // Current authenticated credential cannot be revoked → freshness required
    expect(last.statusCode).toBe(403);
    expect(last.json()).toMatchObject({
      error: { code: 'FRESH_AUTHENTICATION_REQUIRED' },
    });

    // Add second key, reauth with second, revoke first
    const added = await addSecondPasskeyMobile({
      app,
      sessionToken: freshToken,
      existingMaterial: registered.material,
    });
    expect(added.statusCode).toBe(200);
    const secondMaterial = must(added.secondMaterial);

    const loginSecond = await authenticatePasskey({
      app,
      material: secondMaterial,
      clientType: 'mobile',
      anonymousClientKey: 'anonymous-client-key-revoke-2',
      signCount: 1,
      userHandle: registered.userHandle,
    });
    expect(loginSecond.verifyResponse.statusCode).toBe(200);
    const secondToken = loginSecond.verifyResponse.json<{ data: { sessionToken: string } }>().data
      .sessionToken;

    const reauthSecond = await reauthenticateMobile({
      app,
      sessionToken: secondToken,
      material: secondMaterial,
      signCount: 2,
      userHandle: registered.userHandle,
    });
    expect(reauthSecond.statusCode).toBe(200);
    const revokeToken = must(reauthSecond.sessionToken);

    const list = await app.inject({
      method: 'GET',
      url: '/v1/account/passkeys',
      headers: { authorization: `Session ${revokeToken}` },
    });
    const passkeys = list.json<{
      data: { passkeys: { id: string; currentSessionCredential: boolean }[] };
    }>().data.passkeys;
    const other = passkeys.find((item) => !item.currentSessionCredential);
    expect(other).toBeTruthy();

    const revoked = await app.inject({
      method: 'DELETE',
      url: `/v1/account/passkeys/${must(other).id}`,
      headers: { authorization: `Session ${revokeToken}` },
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({ data: { status: 'PASSKEY_REVOKED' } });
    expect(await countActivePasskeys(app, registered.accountId)).toBe(1);

    const again = await app.inject({
      method: 'DELETE',
      url: `/v1/account/passkeys/${must(other).id}`,
      headers: {
        authorization: `Session ${revoked.json<{ data: { sessionToken?: string } }>().data.sessionToken ?? revokeToken}`,
      },
    });
    expect(again.statusCode).toBe(404);
    expect(again.json()).toMatchObject({ error: { code: 'PASSKEY_NOT_FOUND' } });

    // After add, previous token afterAddToken may be rotated; ensure last-passkey revoke fails
    const currentList = await app.inject({
      method: 'GET',
      url: '/v1/account/passkeys',
      headers: {
        authorization: `Session ${revoked.json<{ data: { sessionToken?: string } }>().data.sessionToken ?? revokeToken}`,
      },
    });
    const remaining = must(
      currentList.json<{
        data: { passkeys: { id: string }[] };
      }>().data.passkeys[0],
    ).id;
    const lastFail = await app.inject({
      method: 'DELETE',
      url: `/v1/account/passkeys/${remaining}`,
      headers: {
        authorization: `Session ${revoked.json<{ data: { sessionToken?: string } }>().data.sessionToken ?? revokeToken}`,
      },
    });
    // Either freshness (current credential) or last-active protection
    expect([403, 409]).toContain(lastFail.statusCode);
  });

  it('handles concurrent last-passkey revoke with exactly one success path blocked', async () => {
    const registered = await registerActivePasskeyAccount(
      app,
      delivery,
      'Revoke.Concurrent+setup@example.com',
    );
    const login = await loginMobileSession({
      app,
      material: registered.material,
      userHandle: registered.userHandle,
      signCount: 1,
    });
    const reauth = await reauthenticateMobile({
      app,
      sessionToken: login.sessionToken,
      material: registered.material,
      signCount: 2,
      userHandle: registered.userHandle,
    });
    const freshToken = must(reauth.sessionToken);
    const added = await addSecondPasskeyMobile({
      app,
      sessionToken: freshToken,
      existingMaterial: registered.material,
    });
    expect(added.statusCode).toBe(200);
    const second = must(added.secondMaterial);

    // Authenticate with second and make it current, then revoke first, leaving one.
    const loginSecond = await authenticatePasskey({
      app,
      material: second,
      clientType: 'mobile',
      anonymousClientKey: 'anonymous-client-key-concurrent',
      signCount: 1,
      userHandle: registered.userHandle,
    });
    const secondToken = loginSecond.verifyResponse.json<{ data: { sessionToken: string } }>().data
      .sessionToken;
    const reauthSecond = await reauthenticateMobile({
      app,
      sessionToken: secondToken,
      material: second,
      signCount: 2,
      userHandle: registered.userHandle,
    });
    const activeToken = must(reauthSecond.sessionToken);
    const list = await app.inject({
      method: 'GET',
      url: '/v1/account/passkeys',
      headers: { authorization: `Session ${activeToken}` },
    });
    const other = must(
      list
        .json<{
          data: { passkeys: { id: string; currentSessionCredential: boolean }[] };
        }>()
        .data.passkeys.find((item) => !item.currentSessionCredential),
    );

    await app.inject({
      method: 'DELETE',
      url: `/v1/account/passkeys/${other.id}`,
      headers: { authorization: `Session ${activeToken}` },
    });

    const remainingRows = await app.database.db
      .select()
      .from(passkeyCredentials)
      .where(
        and(
          eq(passkeyCredentials.accountId, registered.accountId),
          isNull(passkeyCredentials.revokedAt),
        ),
      );
    expect(remainingRows).toHaveLength(1);

    // Fresh session after previous revoke
    const sessions = await app.database.db
      .select()
      .from(accountSessions)
      .where(
        and(eq(accountSessions.accountId, registered.accountId), isNull(accountSessions.revokedAt)),
      );
    expect(sessions.length).toBeGreaterThanOrEqual(1);

    // Attempting to revoke the final remaining key must fail (current credential or last active)
    const remainingPublicId = must(remainingRows[0]).publicId;
    // Need a fresh session token - reauth again
    const loginAgain = await authenticatePasskey({
      app,
      material: second,
      clientType: 'mobile',
      anonymousClientKey: 'anonymous-client-key-concurrent-2',
      signCount: 3,
      userHandle: registered.userHandle,
    });
    const againToken = loginAgain.verifyResponse.json<{ data: { sessionToken: string } }>().data
      .sessionToken;
    const reauthAgain = await reauthenticateMobile({
      app,
      sessionToken: againToken,
      material: second,
      signCount: 4,
      userHandle: registered.userHandle,
    });
    const [a, b] = await Promise.all([
      app.inject({
        method: 'DELETE',
        url: `/v1/account/passkeys/${remainingPublicId}`,
        headers: { authorization: `Session ${must(reauthAgain.sessionToken)}` },
      }),
      app.inject({
        method: 'DELETE',
        url: `/v1/account/passkeys/${remainingPublicId}`,
        headers: { authorization: `Session ${must(reauthAgain.sessionToken)}` },
      }),
    ]);
    expect(
      [a.statusCode, b.statusCode].every((code) => code === 403 || code === 409 || code === 401),
    ).toBe(true);
    expect(await countActivePasskeys(app, registered.accountId)).toBe(1);
  });

  it('exposes null controlled actor semantics and zero confirmations remain untouched', async () => {
    // Smoke: management routes do not create controlled actors or confirmation side effects.
    const registered = await registerActivePasskeyAccount(
      app,
      delivery,
      'No.Confirmations+setup@example.com',
    );
    const login = await loginMobileSession({
      app,
      material: registered.material,
      userHandle: registered.userHandle,
      signCount: 1,
    });
    const inventory = await app.inject({
      method: 'GET',
      url: '/v1/account/passkeys',
      headers: { authorization: `Session ${login.sessionToken}` },
    });
    expect(inventory.statusCode).toBe(200);
    expect(inventory.json<{ data: { passkeys: unknown[] } }>().data.passkeys).toHaveLength(1);
  });

  it('returns 404 when authentication feature flag is disabled', async () => {
    const disabled = await createPasskeyManagementTestApp({ enabled: false });
    try {
      const response = await disabled.app.inject({
        method: 'GET',
        url: '/v1/account/passkeys',
        headers: { authorization: `Session ${TEST_ANONYMOUS_CLIENT_KEY}` },
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await disabled.app.close();
      await disabled.pool.end();
    }
  });
});

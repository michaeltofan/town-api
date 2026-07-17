import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import {
  accounts,
  accountSessions,
  emailChallenges,
  identitySecurityEvents,
  recoveryGrants,
  signalConfirmations,
} from '../src/db/schema.js';
import { hashRecoveryCode } from '../src/ceremony/account-recovery/crypto.js';
import { toIsoTimestamp } from '../src/lib/timestamps.js';
import {
  authenticatePasskey,
  completeRecoveryWithNewPasskey,
  countActivePasskeys,
  createAccountRecoveryTestApp,
  createSoftPasskeyMaterial,
  FIXED_RECOVERY_CODE,
  getAccount,
  latestRecoveryChallenge,
  registerActiveAccountForRecovery,
  requestRecovery,
  TEST_ACCOUNT_RECOVERY_HASH_KEY,
  verifyRecoveryEmailRequest,
} from './helpers/account-recovery.js';
import { TEST_ORIGIN, TEST_RP_ID } from './helpers/passkey-authentication.js';

describe('account recovery API', () => {
  let app: Awaited<ReturnType<typeof createAccountRecoveryTestApp>>['app'];
  let pool: Awaited<ReturnType<typeof createAccountRecoveryTestApp>>['pool'];
  let emailDelivery: Awaited<ReturnType<typeof createAccountRecoveryTestApp>>['emailDelivery'];
  let recoveryDelivery: Awaited<
    ReturnType<typeof createAccountRecoveryTestApp>
  >['recoveryDelivery'];
  const nowIso = '2026-07-17T12:00:00.000Z';

  beforeAll(async () => {
    const boot = await createAccountRecoveryTestApp({
      generateCode: () => FIXED_RECOVERY_CODE,
      now: () => nowIso,
    });
    app = boot.app;
    pool = boot.pool;
    emailDelivery = boot.emailDelivery;
    recoveryDelivery = boot.recoveryDelivery;
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('returns 404 when account recovery is disabled', async () => {
    const disabled = await createAccountRecoveryTestApp({ enabled: false });
    try {
      const response = await disabled.app.inject({
        method: 'POST',
        url: '/v1/account/recovery',
        payload: { email: 'anyone@example.com' },
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await disabled.app.close();
      await disabled.pool.end();
    }
  });

  it('anti-enumerates unknown, pending, and suspended accounts with the same 202', async () => {
    const active = await registerActiveAccountForRecovery(
      app,
      emailDelivery,
      'recovery.enum@example.com',
    );

    await app.database.db
      .update(accounts)
      .set({
        status: 'suspended',
        suspendedAt: nowIso,
        updatedAt: nowIso,
      })
      .where(eq(accounts.id, active.accountId));

    const unknown = await requestRecovery(app, 'unknown.recovery@example.com');
    const suspended = await requestRecovery(app, 'recovery.enum@example.com');
    const pendingShell = await requestRecovery(app, 'pending.only@example.com');

    for (const response of [unknown, suspended, pendingShell]) {
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({
        data: { status: 'RECOVERY_REQUEST_ACCEPTED' },
      });
      expect(JSON.stringify(response.json())).not.toContain('challenge');
      expect(JSON.stringify(response.json())).not.toContain('recoveryVerificationId');
    }
  });

  it('issues a 6-digit hash-only recover_account challenge with 10m TTL for active accounts', async () => {
    const active = await registerActiveAccountForRecovery(
      app,
      emailDelivery,
      'recovery.hash@example.com',
    );

    const response = await requestRecovery(app, active.email);
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ data: { status: 'RECOVERY_REQUEST_ACCEPTED' } });

    const challenge = await latestRecoveryChallenge(app, active.accountId);
    expect(challenge.purpose).toBe('recover_account');
    expect(challenge.attemptCount).toBe(0);
    expect(challenge.revokedAt).toBeNull();
    expect(toIsoTimestamp(challenge.expiresAt)).toBe('2026-07-17T12:10:00.000Z');
    expect(
      Buffer.isBuffer(challenge.secretHash) &&
        challenge.secretHash.equals(
          hashRecoveryCode({
            hashKey: TEST_ACCOUNT_RECOVERY_HASH_KEY,
            challengeId: challenge.id,
            purpose: 'recover_account',
            accountId: active.accountId,
            code: FIXED_RECOVERY_CODE,
          }),
        ),
    ).toBe(true);

    const delivered = recoveryDelivery.records.at(-1);
    expect(delivered?.purpose).toBe('recover_account');
    expect(delivered?.code).toBe(FIXED_RECOVERY_CODE);
    expect(/^\d{6}$/.test(delivered?.code ?? '')).toBe(true);
  });

  it('verifies email successfully and returns a recovery grant without creating a session', async () => {
    const active = await registerActiveAccountForRecovery(
      app,
      emailDelivery,
      'recovery.verify@example.com',
    );
    await requestRecovery(app, active.email);
    const challenge = await latestRecoveryChallenge(app, active.accountId);

    const response = await verifyRecoveryEmailRequest(app, {
      recoveryVerificationId: challenge.id,
      code: FIXED_RECOVERY_CODE,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      data: {
        status: string;
        recoveryGrant: string;
        recoveryGrantExpiresAt: string;
      };
    }>();
    expect(body.data.status).toBe('RECOVERY_EMAIL_VERIFIED');
    expect(body.data.recoveryGrant.length).toBeGreaterThan(20);
    expect(body.data.recoveryGrantExpiresAt).toBe('2026-07-17T12:15:00.000Z');
    expect(response.cookies).toHaveLength(0);
    expect(body).not.toHaveProperty('data.sessionToken');

    const sessions = await app.database.db
      .select()
      .from(accountSessions)
      .where(
        and(eq(accountSessions.accountId, active.accountId), isNull(accountSessions.revokedAt)),
      );
    expect(sessions).toHaveLength(0);

    const events = await app.database.db
      .select()
      .from(identitySecurityEvents)
      .where(eq(identitySecurityEvents.accountId, active.accountId));
    expect(events.some((event) => event.eventType === 'recovery_email_verified')).toBe(true);
  });

  it('returns a generic failure for a wrong recovery code', async () => {
    const active = await registerActiveAccountForRecovery(
      app,
      emailDelivery,
      'recovery.wrong@example.com',
    );
    await requestRecovery(app, active.email);
    const challenge = await latestRecoveryChallenge(app, active.accountId);

    const response = await verifyRecoveryEmailRequest(app, {
      recoveryVerificationId: challenge.id,
      code: '000000',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: 'INVALID_OR_EXPIRED_CHALLENGE',
        message: 'The verification challenge is invalid or has expired.',
      },
    });

    const updated = (
      await app.database.db
        .select()
        .from(emailChallenges)
        .where(eq(emailChallenges.id, challenge.id))
        .limit(1)
    )[0];
    expect(updated?.attemptCount).toBe(1);
  });

  it('reuses the existing user handle and excludes active passkeys on recovery options', async () => {
    const active = await registerActiveAccountForRecovery(
      app,
      emailDelivery,
      'recovery.options@example.com',
    );
    await requestRecovery(app, active.email);
    const challenge = await latestRecoveryChallenge(app, active.accountId);
    const verify = await verifyRecoveryEmailRequest(app, {
      recoveryVerificationId: challenge.id,
      code: FIXED_RECOVERY_CODE,
    });
    const grant = verify.json<{ data: { recoveryGrant: string } }>().data.recoveryGrant;

    const optionsResponse = await app.inject({
      method: 'POST',
      url: '/v1/account/recovery/passkeys/registration/options',
      headers: { authorization: `RecoveryGrant ${grant}` },
      payload: {},
    });
    expect(optionsResponse.statusCode).toBe(200);
    const body = optionsResponse.json<{
      data: {
        options: {
          user: { id: string };
          excludeCredentials?: { id: string }[];
          authenticatorSelection?: { residentKey?: string; userVerification?: string };
          attestation?: string;
        };
      };
    }>();

    expect(Buffer.from(body.data.options.user.id, 'base64url')).toEqual(
      Buffer.from(active.userHandle),
    );
    expect(body.data.options.excludeCredentials?.length).toBe(1);
    expect(body.data.options.authenticatorSelection?.residentKey).toBe('required');
    expect(body.data.options.authenticatorSelection?.userVerification).toBe('required');
    expect(body.data.options.attestation).toBe('none');
  });

  it('completes recovery by adding one passkey, keeping old passkeys, revoking sessions, and setting recovery_completed_at', async () => {
    const active = await registerActiveAccountForRecovery(
      app,
      emailDelivery,
      'recovery.complete@example.com',
    );

    const auth = await authenticatePasskey({
      app,
      material: active.material,
      clientType: 'mobile',
      userHandle: active.userHandle,
    });
    expect(auth.verifyResponse.statusCode).toBe(200);
    const sessionToken = auth.verifyResponse.json<{ data: { sessionToken?: string } }>().data
      .sessionToken;
    expect(sessionToken).toBeTruthy();

    expect(await countActivePasskeys(app, active.accountId)).toBe(1);

    await requestRecovery(app, active.email);
    const challenge = await latestRecoveryChallenge(app, active.accountId);
    const verify = await verifyRecoveryEmailRequest(app, {
      recoveryVerificationId: challenge.id,
      code: FIXED_RECOVERY_CODE,
    });
    const grant = verify.json<{ data: { recoveryGrant: string } }>().data.recoveryGrant;

    const completion = await completeRecoveryWithNewPasskey({
      app,
      recoveryGrant: grant,
      existingUserHandle: active.userHandle,
      material: createSoftPasskeyMaterial(),
    });
    expect(completion.verifyResponse.statusCode).toBe(200);
    expect(completion.verifyResponse.json()).toEqual({
      data: { status: 'RECOVERY_COMPLETE' },
    });
    expect(completion.verifyResponse.cookies).toHaveLength(0);
    expect(completion.verifyResponse.json()).not.toHaveProperty('data.sessionToken');
    expect(completion.verifyResponse.headers['set-cookie']).toBeUndefined();

    expect(await countActivePasskeys(app, active.accountId)).toBe(2);

    const account = await getAccount(app, active.accountId);
    expect(account?.status).toBe('active');
    expect(account?.recoveryCompletedAt).not.toBeNull();
    expect(account?.recoveryCompletedAt).toBeTruthy();
    expect(toIsoTimestamp(account?.recoveryCompletedAt ?? '')).toBe(nowIso);

    const sessions = await app.database.db
      .select()
      .from(accountSessions)
      .where(eq(accountSessions.accountId, active.accountId));
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((session) => session.revokedAt !== null)).toBe(true);
    expect(sessions.every((session) => session.revocationReason === 'recovery_completed')).toBe(
      true,
    );

    const grants = await app.database.db
      .select()
      .from(recoveryGrants)
      .where(eq(recoveryGrants.accountId, active.accountId));
    expect(
      grants.every((grantRow) => grantRow.consumedAt !== null || grantRow.revokedAt !== null),
    ).toBe(true);

    const events = await app.database.db
      .select()
      .from(identitySecurityEvents)
      .where(eq(identitySecurityEvents.accountId, active.accountId));
    expect(events.some((event) => event.eventType === 'passkey_registered')).toBe(true);
    expect(events.some((event) => event.eventType === 'recovery_completed')).toBe(true);
    expect(events.some((event) => event.eventType === 'session_revoked')).toBe(true);

    const confirmations = await app.database.db.select().from(signalConfirmations);
    expect(confirmations).toHaveLength(0);

    const sessionInspect = await app.inject({
      method: 'GET',
      url: '/v1/authentication/session',
      headers: {
        authorization: `Session ${sessionToken ?? 'missing'}`,
      },
    });
    expect(sessionInspect.json()).toMatchObject({
      data: { authenticated: false },
    });
  });

  it('returns generic 202 when recovery request rate limits are exceeded', async () => {
    const email = 'recovery.throttle@example.com';
    for (let i = 0; i < 4; i += 1) {
      const response = await requestRecovery(app, email, { remoteAddress: '203.0.113.50' });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ data: { status: 'RECOVERY_REQUEST_ACCEPTED' } });
    }

    const challenges = await app.database.db
      .select()
      .from(emailChallenges)
      .where(eq(emailChallenges.purpose, 'recover_account'));
    expect(
      challenges.filter((row) => row.emailNormalized === 'recovery.throttle@example.com'),
    ).toHaveLength(0);
  });

  it('allows only one concurrent recovery completion', async () => {
    const active = await registerActiveAccountForRecovery(
      app,
      emailDelivery,
      'recovery.concurrent@example.com',
    );
    await requestRecovery(app, active.email);
    const challenge = await latestRecoveryChallenge(app, active.accountId);
    const verify = await verifyRecoveryEmailRequest(app, {
      recoveryVerificationId: challenge.id,
      code: FIXED_RECOVERY_CODE,
    });
    const grant = verify.json<{ data: { recoveryGrant: string } }>().data.recoveryGrant;

    const materialA = createSoftPasskeyMaterial();
    const materialB = createSoftPasskeyMaterial();

    const options = await app.inject({
      method: 'POST',
      url: '/v1/account/recovery/passkeys/registration/options',
      headers: { authorization: `RecoveryGrant ${grant}` },
      payload: {},
    });
    expect(options.statusCode).toBe(200);
    const optionsBody = options.json<{
      data: { recoveryCeremonyId: string; options: { challenge: string } };
    }>();

    const [first, second] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/v1/account/recovery/passkeys/registration/verify',
        headers: { authorization: `RecoveryGrant ${grant}` },
        payload: {
          recoveryCeremonyId: optionsBody.data.recoveryCeremonyId,
          response: materialA.createRegistrationResponse({
            challenge: optionsBody.data.options.challenge,
            rpID: TEST_RP_ID,
            origin: TEST_ORIGIN,
          }),
        },
      }),
      app.inject({
        method: 'POST',
        url: '/v1/account/recovery/passkeys/registration/verify',
        headers: { authorization: `RecoveryGrant ${grant}` },
        payload: {
          recoveryCeremonyId: optionsBody.data.recoveryCeremonyId,
          response: materialB.createRegistrationResponse({
            challenge: optionsBody.data.options.challenge,
            rpID: TEST_RP_ID,
            origin: TEST_ORIGIN,
          }),
        },
      }),
    ]);

    const statuses = [first.statusCode, second.statusCode].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 400]);
    expect(await countActivePasskeys(app, active.accountId)).toBe(2);

    const account = await getAccount(app, active.accountId);
    expect(account?.recoveryCompletedAt).not.toBeNull();
  });
});

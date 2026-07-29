import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { count, eq, sql } from 'drizzle-orm';
import type { AppInstance } from '../src/app.js';
import { hashVerificationCode } from '../src/ceremony/email-verification/crypto.js';
import {
  accountEmails,
  accountSessions,
  accounts,
  actors,
  emailChallenges,
  passkeyCredentials,
  setupGrants,
  signalConfirmations,
  type EmailChallengeRow,
} from '../src/db/schema.js';
import { CONTROLLED_TEST_ACTOR_ID } from '../src/db/seeds/controlled-actor-content.js';
import { normalizeEmail } from '../src/identity/email-normalize.js';
import { toIsoTimestamp } from '../src/lib/timestamps.js';
import {
  createEmailVerificationTestApp,
  TEST_EMAIL_VERIFICATION_HASH_KEY,
} from './helpers/email-verification.js';

const FIXED_NOW = '2026-07-16T14:00:00.000Z';
const FIXED_CODE = '012345';

describe('email verification runtime API', () => {
  let app: AppInstance | undefined;
  let pool: Awaited<ReturnType<typeof createEmailVerificationTestApp>>['pool'] | undefined;
  let delivery: Awaited<ReturnType<typeof createEmailVerificationTestApp>>['delivery'] | undefined;

  async function boot(options?: Parameters<typeof createEmailVerificationTestApp>[0]) {
    if (app !== undefined) {
      await app.close();
    }
    if (pool !== undefined) {
      await pool.end();
    }
    const created = await createEmailVerificationTestApp({
      now: () => FIXED_NOW,
      generateCode: () => FIXED_CODE,
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

  async function latestChallenge(): Promise<EmailChallengeRow> {
    const rows = await currentApp().database.db.select().from(emailChallenges);
    const challenge = rows[0];
    if (!challenge) {
      throw new Error('expected challenge');
    }
    return challenge;
  }

  it('defaults disabled feature to safe not-found', async () => {
    await boot({ enabled: false });
    const response = await currentApp().inject({
      method: 'POST',
      url: '/v1/account/email-verifications',
      payload: { email: 'New.User+signup@example.com' },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: {
        code: 'NOT_FOUND',
        message: 'Not Found.',
      },
    });
  });

  const UUID_PATTERN =
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

  it('returns equivalent accepted responses for known and unknown emails', async () => {
    const unknown = await currentApp().inject({
      method: 'POST',
      url: '/v1/account/email-verifications',
      payload: { email: 'Brand.New+one@example.com' },
    });
    expect(unknown.statusCode).toBe(202);
    const unknownBody = unknown.json<{
      data: { status: string; verificationId: string };
    }>();
    expect(unknownBody.data.status).toBe('VERIFICATION_REQUEST_ACCEPTED');
    expect(unknownBody.data.verificationId).toMatch(UUID_PATTERN);

    const again = await currentApp().inject({
      method: 'POST',
      url: '/v1/account/email-verifications',
      remoteAddress: '127.0.0.2',
      payload: { email: 'Brand.New+one@example.com' },
    });
    expect(again.statusCode).toBe(202);
    const againBody = again.json<{
      data: { status: string; verificationId: string };
    }>();
    expect(againBody.data.status).toBe(unknownBody.data.status);
    expect(againBody.data.verificationId).toMatch(UUID_PATTERN);
    expect(Object.keys(againBody.data).sort()).toEqual(Object.keys(unknownBody.data).sort());
  });

  it('creates pending_email account and challenge without actor/passkey/session', async () => {
    const email = 'Setup.User+create@example.org';
    await currentApp().inject({
      method: 'POST',
      url: '/v1/account/email-verifications',
      payload: { email, locale: 'en' },
    });

    const db = currentApp().database.db;
    expect((await db.select({ value: count() }).from(accounts))[0]?.value).toBe(1);
    expect((await db.select({ value: count() }).from(accountEmails))[0]?.value).toBe(1);
    expect((await db.select({ value: count() }).from(emailChallenges))[0]?.value).toBe(1);
    expect((await db.select({ value: count() }).from(actors))[0]?.value).toBe(1);
    const controlled = await db
      .select()
      .from(actors)
      .where(eq(actors.id, CONTROLLED_TEST_ACTOR_ID));
    expect(controlled[0]?.accountId).toBeNull();
    expect((await db.select({ value: count() }).from(passkeyCredentials))[0]?.value).toBe(0);
    expect((await db.select({ value: count() }).from(accountSessions))[0]?.value).toBe(0);
    expect((await db.select({ value: count() }).from(setupGrants))[0]?.value).toBe(0);

    const account = (await db.select().from(accounts))[0];
    expect(account?.status).toBe('pending_email');
    const emailRow = (await db.select().from(accountEmails))[0];
    expect(emailRow?.emailNormalized).toBe(normalizeEmail(email));
    expect(emailRow?.verifiedAt).toBeNull();
    expect(emailRow?.isPrimary).toBe(true);

    const challenge = await latestChallenge();
    expect(challenge.purpose).toBe('verify_email');
    expect(challenge.attemptCount).toBe(0);
    expect(challenge.revokedAt).toBeNull();
    expect(toIsoTimestamp(challenge.expiresAt)).toBe('2026-07-16T14:10:00.000Z');
    expect(
      challenge.secretHash.equals(
        hashVerificationCode({
          hashKey: TEST_EMAIL_VERIFICATION_HASH_KEY,
          challengeId: challenge.id,
          purpose: 'verify_email',
          code: FIXED_CODE,
        }),
      ),
    ).toBe(true);

    expect(delivery?.records[0]?.code).toBe(FIXED_CODE);
  });

  it('completes verification once, issues setup grant, and rejects replay', async () => {
    const email = 'Complete.User+ok@example.com';
    const request = await currentApp().inject({
      method: 'POST',
      url: '/v1/account/email-verifications',
      payload: { email },
    });
    expect(request.statusCode).toBe(202);
    const verificationId = request.json<{
      data: { verificationId: string };
    }>().data.verificationId;
    expect(verificationId).toMatch(
      /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/,
    );

    const success = await currentApp().inject({
      method: 'POST',
      url: '/v1/account/email-verifications/complete',
      payload: { verificationId, code: FIXED_CODE },
    });
    expect(success.statusCode).toBe(200);
    expect(JSON.stringify(success.json())).toContain('"status":"EMAIL_VERIFIED"');
    expect(JSON.stringify(success.json())).toContain(
      '"setupGrantExpiresAt":"2026-07-16T14:15:00.000Z"',
    );
    expect(JSON.stringify(success.json())).toMatch(/"setupGrant":"[A-Za-z0-9_-]{20,}"/);

    const db = currentApp().database.db;
    const account = (await db.select().from(accounts))[0];
    expect(account?.status).toBe('pending_password');
    const emailRow = (await db.select().from(accountEmails))[0];
    expect(emailRow?.verifiedAt).not.toBeNull();
    expect((await db.select({ value: count() }).from(setupGrants))[0]?.value).toBe(1);
    const grant = (await db.select().from(setupGrants))[0];
    expect(grant?.purpose).toBe('initial_password_setup');
    expect((await db.select({ value: count() }).from(accountSessions))[0]?.value).toBe(0);
    expect((await db.select({ value: count() }).from(passkeyCredentials))[0]?.value).toBe(0);
    const controlled = await db
      .select()
      .from(actors)
      .where(eq(actors.id, CONTROLLED_TEST_ACTOR_ID));
    expect(controlled[0]?.accountId).toBeNull();
    expect((await db.select({ value: count() }).from(signalConfirmations))[0]?.value).toBe(0);

    const replay = await currentApp().inject({
      method: 'POST',
      url: '/v1/account/email-verifications/complete',
      payload: { verificationId, code: FIXED_CODE },
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.json()).toMatchObject({
      error: {
        code: 'INVALID_OR_EXPIRED_CHALLENGE',
        message: 'The verification challenge is invalid or has expired.',
      },
    });
    expect((await db.select({ value: count() }).from(setupGrants))[0]?.value).toBe(1);
  });

  it('returns generic invalid challenge for wrong code and increments attempts', async () => {
    const email = 'Fail.User+code@example.net';
    await currentApp().inject({
      method: 'POST',
      url: '/v1/account/email-verifications',
      payload: { email },
    });
    const challenge = await latestChallenge();

    const wrong = await currentApp().inject({
      method: 'POST',
      url: '/v1/account/email-verifications/complete',
      payload: { verificationId: challenge.id, code: '999999' },
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toMatchObject({
      error: { code: 'INVALID_OR_EXPIRED_CHALLENGE' },
    });

    const updated = (
      await currentApp()
        .database.db.select()
        .from(emailChallenges)
        .where(eq(emailChallenges.id, challenge.id))
    )[0];
    expect(updated?.attemptCount).toBe(1);
    expect(updated?.consumedAt).toBeNull();
  });

  it('invalidates prior challenge on resend', async () => {
    let nowMs = Date.parse(FIXED_NOW);
    await boot({
      now: () => new Date(nowMs).toISOString(),
      generateCode: () => FIXED_CODE,
    });
    const email = 'Resend.User+two@example.com';
    await currentApp().inject({
      method: 'POST',
      url: '/v1/account/email-verifications',
      payload: { email },
    });
    const first = await latestChallenge();

    nowMs += 61_000;
    await currentApp().inject({
      method: 'POST',
      url: '/v1/account/email-verifications',
      remoteAddress: '127.0.0.3',
      payload: { email },
    });
    const challenges = await currentApp().database.db.select().from(emailChallenges);
    expect(challenges).toHaveLength(2);
    const revoked = challenges.find((row) => row.id === first.id);
    expect(revoked?.revokedAt).not.toBeNull();

    const fail = await currentApp().inject({
      method: 'POST',
      url: '/v1/account/email-verifications/complete',
      payload: { verificationId: first.id, code: FIXED_CODE },
    });
    expect(fail.statusCode).toBe(400);
  });

  it('allows exactly one concurrent successful completion', async () => {
    const email = 'Race.User+once@example.com';
    await currentApp().inject({
      method: 'POST',
      url: '/v1/account/email-verifications',
      payload: { email },
    });
    const challenge = await latestChallenge();

    const results = await Promise.all(
      [0, 1].map(() =>
        currentApp().inject({
          method: 'POST',
          url: '/v1/account/email-verifications/complete',
          payload: { verificationId: challenge.id, code: FIXED_CODE },
        }),
      ),
    );
    const successes = results.filter((response) => response.statusCode === 200);
    const failures = results.filter((response) => response.statusCode === 400);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(
      (await currentApp().database.db.select({ value: count() }).from(setupGrants))[0]?.value,
    ).toBe(1);
  });

  it('rejects exhausted attempts with generic error', async () => {
    const email = 'Attempts.User+five@example.com';
    await currentApp().inject({
      method: 'POST',
      url: '/v1/account/email-verifications',
      payload: { email },
    });
    const challenge = await latestChallenge();

    for (let index = 0; index < 5; index += 1) {
      const response = await currentApp().inject({
        method: 'POST',
        url: '/v1/account/email-verifications/complete',
        payload: { verificationId: challenge.id, code: '000000' },
      });
      expect(response.statusCode).toBe(400);
    }

    const after = (
      await currentApp()
        .database.db.select()
        .from(emailChallenges)
        .where(eq(emailChallenges.id, challenge.id))
    )[0];
    expect(after?.attemptCount).toBe(5);

    const correctLate = await currentApp().inject({
      method: 'POST',
      url: '/v1/account/email-verifications/complete',
      payload: { verificationId: challenge.id, code: FIXED_CODE },
    });
    expect(correctLate.statusCode).toBe(400);
  });

  it('creates exactly one account and primary email for a new identity', async () => {
    const email = '  Atomic.Create+one@Example.ORG  ';
    const response = await currentApp().inject({
      method: 'POST',
      url: '/v1/account/email-verifications',
      payload: { email },
    });
    expect(response.statusCode).toBe(202);
    const body = response.json<{ data: { status: string; verificationId: string } }>();
    expect(body.data.status).toBe('VERIFICATION_REQUEST_ACCEPTED');
    expect(JSON.stringify(response.json())).not.toMatch(/Atomic\.Create\+one@example\.org/i);

    const db = currentApp().database.db;
    expect((await db.select({ value: count() }).from(accounts))[0]?.value).toBe(1);
    expect((await db.select({ value: count() }).from(accountEmails))[0]?.value).toBe(1);
    const emailRow = (await db.select().from(accountEmails))[0];
    expect(emailRow?.emailNormalized).toBe('Atomic.Create+one@example.org');
    expect(emailRow?.isPrimary).toBe(true);
    expect(emailRow?.revokedAt).toBeNull();
  });

  it('rolls back the account shell when email insert fails inside ensurePendingEmailAccount', async () => {
    const db = currentApp().database.db;
    await db.execute(sql`
      CREATE OR REPLACE FUNCTION town.force_email_insert_failure()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'forced email insert failure';
      END;
      $$;
    `);
    await db.execute(sql`
      CREATE TRIGGER force_email_insert_failure
      BEFORE INSERT ON town.account_emails
      FOR EACH ROW
      EXECUTE FUNCTION town.force_email_insert_failure();
    `);

    try {
      const response = await currentApp().inject({
        method: 'POST',
        url: '/v1/account/email-verifications',
        payload: { email: 'rollback.shell@example.com' },
      });
      // Public contract stays enumeration-resistant even on internal failure paths.
      expect([202, 500]).toContain(response.statusCode);
      if (response.statusCode === 202) {
        expect(response.json()).toMatchObject({
          data: { status: 'VERIFICATION_REQUEST_ACCEPTED' },
        });
      }
      expect(JSON.stringify(response.json())).not.toMatch(/rollback\.shell@example\.com/i);
      expect((await db.select({ value: count() }).from(accounts))[0]?.value).toBe(0);
      expect((await db.select({ value: count() }).from(accountEmails))[0]?.value).toBe(0);
    } finally {
      await db.execute(
        sql`DROP TRIGGER IF EXISTS force_email_insert_failure ON town.account_emails`,
      );
      await db.execute(sql`DROP FUNCTION IF EXISTS town.force_email_insert_failure()`);
    }
  });

  it('converges concurrent identical requests onto one account', async () => {
    const email = 'Concurrent.Same+tag@example.com';
    const results = await Promise.all([
      currentApp().inject({
        method: 'POST',
        url: '/v1/account/email-verifications',
        remoteAddress: '127.0.0.10',
        payload: { email },
      }),
      currentApp().inject({
        method: 'POST',
        url: '/v1/account/email-verifications',
        remoteAddress: '127.0.0.11',
        payload: { email },
      }),
      currentApp().inject({
        method: 'POST',
        url: '/v1/account/email-verifications',
        remoteAddress: '127.0.0.12',
        payload: { email: '  Concurrent.Same+tag@EXAMPLE.COM  ' },
      }),
    ]);
    for (const response of results) {
      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({
        data: { status: 'VERIFICATION_REQUEST_ACCEPTED' },
      });
      expect(JSON.stringify(response.json())).not.toMatch(/Concurrent\.Same\+tag@example\.com/i);
    }

    const db = currentApp().database.db;
    expect((await db.select({ value: count() }).from(accounts))[0]?.value).toBe(1);
    expect((await db.select({ value: count() }).from(accountEmails))[0]?.value).toBe(1);
    const emailRow = (await db.select().from(accountEmails))[0];
    expect(emailRow?.emailNormalized).toBe('Concurrent.Same+tag@example.com');
  });

  it('reuses the same pending account on repeated requests', async () => {
    let nowMs = Date.parse(FIXED_NOW);
    await boot({
      now: () => new Date(nowMs).toISOString(),
      generateCode: () => FIXED_CODE,
    });
    const email = 'Reuse.Pending+again@example.com';
    await currentApp().inject({
      method: 'POST',
      url: '/v1/account/email-verifications',
      payload: { email },
    });
    const firstAccount = (await currentApp().database.db.select().from(accounts))[0];
    expect(firstAccount?.status).toBe('pending_email');

    nowMs += 61_000;
    await currentApp().inject({
      method: 'POST',
      url: '/v1/account/email-verifications',
      remoteAddress: '127.0.0.20',
      payload: { email: 'Reuse.Pending+again@EXAMPLE.com' },
    });

    const db = currentApp().database.db;
    expect((await db.select({ value: count() }).from(accounts))[0]?.value).toBe(1);
    expect((await db.select().from(accounts))[0]?.id).toBe(firstAccount?.id);
  });

  it('blocks silent reuse of a revoked email by another account', async () => {
    const email = 'Revoked.Owner+hist@example.com';
    await currentApp().inject({
      method: 'POST',
      url: '/v1/account/email-verifications',
      payload: { email },
    });
    const db = currentApp().database.db;
    const original = (await db.select().from(accountEmails))[0];
    expect(original).toBeDefined();
    if (original === undefined) {
      throw new Error('expected original email');
    }

    await db
      .update(accountEmails)
      .set({ revokedAt: FIXED_NOW, isPrimary: false, updatedAt: FIXED_NOW })
      .where(eq(accountEmails.id, original.id));

    const again = await currentApp().inject({
      method: 'POST',
      url: '/v1/account/email-verifications',
      remoteAddress: '127.0.0.30',
      payload: { email: 'Revoked.Owner+hist@EXAMPLE.com' },
    });
    expect(again.statusCode).toBe(202);
    expect(again.json()).toMatchObject({
      data: { status: 'VERIFICATION_REQUEST_ACCEPTED' },
    });
    expect(JSON.stringify(again.json())).not.toMatch(/Revoked\.Owner\+hist@example\.com/i);

    expect((await db.select({ value: count() }).from(accounts))[0]?.value).toBe(1);
    expect((await db.select({ value: count() }).from(accountEmails))[0]?.value).toBe(1);
    const historical = (await db.select().from(accountEmails))[0];
    expect(historical?.id).toBe(original.id);
    expect(historical?.accountId).toBe(original.accountId);
    expect(historical?.revokedAt).not.toBeNull();
    expect((await db.select({ value: count() }).from(emailChallenges))[0]?.value).toBe(1);
  });

  it('supports pending_password re-entry with a fresh password-setup grant', async () => {
    let nowMs = Date.parse(FIXED_NOW);
    await boot({
      now: () => new Date(nowMs).toISOString(),
      generateCode: () => FIXED_CODE,
      generateSetupToken: () => `setup-token-${String(nowMs)}`,
    });
    const email = 'Reentry.Password+ok@example.com';
    const firstRequest = await currentApp().inject({
      method: 'POST',
      url: '/v1/account/email-verifications',
      payload: { email },
    });
    const firstVerificationId = firstRequest.json<{
      data: { verificationId: string };
    }>().data.verificationId;
    const firstComplete = await currentApp().inject({
      method: 'POST',
      url: '/v1/account/email-verifications/complete',
      payload: { verificationId: firstVerificationId, code: FIXED_CODE },
    });
    expect(firstComplete.statusCode).toBe(200);
    const firstGrant = firstComplete.json<{ data: { setupGrant: string } }>().data.setupGrant;

    const db = currentApp().database.db;
    const accountBefore = (await db.select().from(accounts))[0];
    expect(accountBefore?.status).toBe('pending_password');
    expect((await db.select().from(setupGrants))[0]?.purpose).toBe('initial_password_setup');

    nowMs += 61_000;
    const reentryRequest = await currentApp().inject({
      method: 'POST',
      url: '/v1/account/email-verifications',
      remoteAddress: '127.0.0.39',
      payload: { email: 'Reentry.Password+ok@EXAMPLE.com' },
    });
    expect(reentryRequest.statusCode).toBe(202);
    const reentryBody = reentryRequest.json<{
      data: { status: string; verificationId: string };
    }>();

    const reentryComplete = await currentApp().inject({
      method: 'POST',
      url: '/v1/account/email-verifications/complete',
      payload: { verificationId: reentryBody.data.verificationId, code: FIXED_CODE },
    });
    expect(reentryComplete.statusCode).toBe(200);
    const reentryGrant = reentryComplete.json<{
      data: { status: string; setupGrant: string };
    }>().data;
    expect(reentryGrant.setupGrant).not.toBe(firstGrant);

    const accountAfter = (await db.select().from(accounts))[0];
    expect(accountAfter?.status).toBe('pending_password');
    expect(accountAfter?.id).toBe(accountBefore?.id);
    expect((await db.select({ value: count() }).from(accounts))[0]?.value).toBe(1);

    const grants = await db.select().from(setupGrants);
    expect(grants.every((row) => row.purpose === 'initial_password_setup')).toBe(true);
    const activeGrants = grants.filter((row) => row.revokedAt == null && row.consumedAt == null);
    expect(activeGrants).toHaveLength(1);
  });

  it('supports pending_passkey re-entry with a fresh challenge and setup grant', async () => {
    let nowMs = Date.parse(FIXED_NOW);
    await boot({
      now: () => new Date(nowMs).toISOString(),
      generateCode: () => FIXED_CODE,
      generateSetupToken: () => `setup-token-${String(nowMs)}`,
    });
    const email = 'Reentry.Passkey+ok@example.com';
    const firstRequest = await currentApp().inject({
      method: 'POST',
      url: '/v1/account/email-verifications',
      payload: { email },
    });
    const firstVerificationId = firstRequest.json<{
      data: { verificationId: string };
    }>().data.verificationId;
    const firstComplete = await currentApp().inject({
      method: 'POST',
      url: '/v1/account/email-verifications/complete',
      payload: { verificationId: firstVerificationId, code: FIXED_CODE },
    });
    expect(firstComplete.statusCode).toBe(200);

    // Mechanically advance past password setup so re-entry targets pending_passkey.
    await currentApp().database.db.execute(
      sql`UPDATE town.accounts SET status = 'pending_passkey', updated_at = ${FIXED_NOW} WHERE status = 'pending_password'`,
    );
    await currentApp().database.db.execute(
      sql`UPDATE town.setup_grants SET revoked_at = ${FIXED_NOW} WHERE purpose = 'initial_password_setup'`,
    );
    const passkeyGrantId = 'aaaaaaaa-0000-4000-8000-000000000099';
    const passkeyTokenHash = Buffer.alloc(32, 7);
    await currentApp().database.db.insert(setupGrants).values({
      id: passkeyGrantId,
      accountId: (await currentApp().database.db.select().from(accounts))[0]!.id,
      tokenHash: passkeyTokenHash,
      purpose: 'initial_passkey_registration',
      expiresAt: new Date(nowMs + 15 * 60_000).toISOString(),
      createdAt: FIXED_NOW,
      consumedAt: null,
      revokedAt: null,
    });
    const firstGrant = 'prior-passkey-grant-token';

    const db = currentApp().database.db;
    const accountBefore = (await db.select().from(accounts))[0];
    expect(accountBefore?.status).toBe('pending_passkey');

    nowMs += 61_000;
    const reentryRequest = await currentApp().inject({
      method: 'POST',
      url: '/v1/account/email-verifications',
      remoteAddress: '127.0.0.40',
      payload: { email: 'Reentry.Passkey+ok@EXAMPLE.com' },
    });
    expect(reentryRequest.statusCode).toBe(202);
    const reentryBody = reentryRequest.json<{
      data: { status: string; verificationId: string };
    }>();
    expect(reentryBody.data.status).toBe('VERIFICATION_REQUEST_ACCEPTED');
    expect(reentryBody.data.verificationId).toMatch(UUID_PATTERN);
    expect(JSON.stringify(reentryRequest.json())).not.toMatch(/Reentry\.Passkey\+ok@example\.com/i);

    const accountAfterRequest = (await db.select().from(accounts))[0];
    expect(accountAfterRequest?.id).toBe(accountBefore?.id);
    expect(accountAfterRequest?.status).toBe('pending_passkey');
    expect((await db.select({ value: count() }).from(accounts))[0]?.value).toBe(1);

    const challenges = await db.select().from(emailChallenges);
    const activeChallenge = challenges.find(
      (row) =>
        row.revokedAt == null &&
        row.consumedAt == null &&
        row.id === reentryBody.data.verificationId,
    );
    expect(activeChallenge).toBeTruthy();
    expect(activeChallenge?.accountId).toBe(accountBefore?.id);

    const reentryComplete = await currentApp().inject({
      method: 'POST',
      url: '/v1/account/email-verifications/complete',
      payload: { verificationId: reentryBody.data.verificationId, code: FIXED_CODE },
    });
    expect(reentryComplete.statusCode).toBe(200);
    const reentryGrant = reentryComplete.json<{
      data: { status: string; setupGrant: string; setupGrantExpiresAt: string };
    }>().data;
    expect(reentryGrant.status).toBe('EMAIL_VERIFIED');
    expect(reentryGrant.setupGrant).not.toBe(firstGrant);
    expect(reentryGrant.setupGrantExpiresAt).toBe(new Date(nowMs + 15 * 60_000).toISOString());

    const accountAfter = (await db.select().from(accounts))[0];
    expect(accountAfter?.status).toBe('pending_passkey');
    expect(accountAfter?.id).toBe(accountBefore?.id);

    const grants = await db.select().from(setupGrants);
    const passkeyGrants = grants.filter((row) => row.purpose === 'initial_passkey_registration');
    const activePasskeyGrants = passkeyGrants.filter(
      (row) => row.revokedAt == null && row.consumedAt == null,
    );
    expect(activePasskeyGrants).toHaveLength(1);
    expect(activePasskeyGrants[0]?.accountId).toBe(accountBefore?.id);

    const oldChallengeReplay = await currentApp().inject({
      method: 'POST',
      url: '/v1/account/email-verifications/complete',
      payload: { verificationId: firstVerificationId, code: FIXED_CODE },
    });
    expect(oldChallengeReplay.statusCode).toBe(400);

    const revokedPrior = passkeyGrants.find((row) => row.revokedAt != null);
    expect(revokedPrior).toBeTruthy();
  });

  it('converges concurrent pending_passkey re-entry requests onto one account', async () => {
    let nowMs = Date.parse(FIXED_NOW);
    await boot({
      now: () => new Date(nowMs).toISOString(),
      generateCode: () => FIXED_CODE,
    });
    const email = 'Concurrent.Reentry+ok@example.com';
    const request = await currentApp().inject({
      method: 'POST',
      url: '/v1/account/email-verifications',
      payload: { email },
    });
    const verificationId = request.json<{ data: { verificationId: string } }>().data.verificationId;
    await currentApp().inject({
      method: 'POST',
      url: '/v1/account/email-verifications/complete',
      payload: { verificationId, code: FIXED_CODE },
    });
    await currentApp().database.db.execute(
      sql`UPDATE town.accounts SET status = 'pending_passkey', updated_at = ${FIXED_NOW} WHERE status = 'pending_password'`,
    );
    const accountId = (await currentApp().database.db.select().from(accounts))[0]?.id;
    expect(accountId).toBeDefined();

    nowMs += 61_000;
    const results = await Promise.all([
      currentApp().inject({
        method: 'POST',
        url: '/v1/account/email-verifications',
        remoteAddress: '127.0.0.71',
        payload: { email },
      }),
      currentApp().inject({
        method: 'POST',
        url: '/v1/account/email-verifications',
        remoteAddress: '127.0.0.72',
        payload: { email: 'Concurrent.Reentry+ok@EXAMPLE.com' },
      }),
    ]);
    expect(results.every((response) => response.statusCode === 202)).toBe(true);

    const db = currentApp().database.db;
    expect((await db.select({ value: count() }).from(accounts))[0]?.value).toBe(1);
    expect((await db.select().from(accounts))[0]?.id).toBe(accountId);
    expect((await db.select().from(accounts))[0]?.status).toBe('pending_passkey');
    expect((await db.select({ value: count() }).from(accountEmails))[0]?.value).toBe(1);
  });

  it('keeps active account request suppression unchanged', async () => {
    const email = 'Active.Suppress+keep@example.com';
    const request = await currentApp().inject({
      method: 'POST',
      url: '/v1/account/email-verifications',
      payload: { email },
    });
    const verificationId = request.json<{ data: { verificationId: string } }>().data.verificationId;
    await currentApp().inject({
      method: 'POST',
      url: '/v1/account/email-verifications/complete',
      payload: { verificationId, code: FIXED_CODE },
    });

    const db = currentApp().database.db;
    const account = (await db.select().from(accounts))[0];
    expect(account).toBeDefined();
    if (account === undefined) {
      throw new Error('expected account');
    }
    await db
      .update(accounts)
      .set({
        status: 'active',
        accountReadyAt: FIXED_NOW,
        webauthnUserHandle: Buffer.alloc(32, 7),
        updatedAt: FIXED_NOW,
      })
      .where(eq(accounts.id, account.id));

    const challengesBefore = (await db.select({ value: count() }).from(emailChallenges))[0]?.value;

    const suppressed = await currentApp().inject({
      method: 'POST',
      url: '/v1/account/email-verifications',
      remoteAddress: '127.0.0.50',
      payload: { email },
    });
    expect(suppressed.statusCode).toBe(202);
    expect(suppressed.json()).toMatchObject({
      data: { status: 'VERIFICATION_REQUEST_ACCEPTED' },
    });
    expect((await db.select({ value: count() }).from(emailChallenges))[0]?.value).toBe(
      challengesBefore,
    );
    expect((await db.select({ value: count() }).from(accounts))[0]?.value).toBe(1);
    expect(delivery?.records.at(-1)?.outcomeCategory).toBe('existing_account_guidance');
  });

  it('keeps suspended and closed request suppression unchanged', async () => {
    for (const status of ['suspended', 'closed'] as const) {
      await boot();
      const email = `${status}.suppress+keep@example.com`;
      const request = await currentApp().inject({
        method: 'POST',
        url: '/v1/account/email-verifications',
        payload: { email },
      });
      const verificationId = request.json<{ data: { verificationId: string } }>().data
        .verificationId;
      await currentApp().inject({
        method: 'POST',
        url: '/v1/account/email-verifications/complete',
        payload: { verificationId, code: FIXED_CODE },
      });

      const db = currentApp().database.db;
      const account = (await db.select().from(accounts))[0];
      expect(account).toBeDefined();
      if (account === undefined) {
        throw new Error('expected account');
      }
      await db
        .update(accounts)
        .set({
          status,
          accountReadyAt: FIXED_NOW,
          webauthnUserHandle: Buffer.alloc(32, 9),
          suspendedAt: status === 'suspended' ? FIXED_NOW : null,
          closedAt: status === 'closed' ? FIXED_NOW : null,
          updatedAt: FIXED_NOW,
        })
        .where(eq(accounts.id, account.id));

      const challengesBefore = (await db.select({ value: count() }).from(emailChallenges))[0]
        ?.value;
      const suppressed = await currentApp().inject({
        method: 'POST',
        url: '/v1/account/email-verifications',
        remoteAddress: '127.0.0.60',
        payload: { email },
      });
      expect(suppressed.statusCode).toBe(202);
      expect((await db.select({ value: count() }).from(emailChallenges))[0]?.value).toBe(
        challengesBefore,
      );
      expect(delivery?.records.at(-1)?.outcomeCategory).toBe('suppressed');
    }
  });

  it('does not leave two simultaneously valid setup grants from separate challenges', async () => {
    let nowMs = Date.parse(FIXED_NOW);
    await boot({
      now: () => new Date(nowMs).toISOString(),
      generateCode: () => FIXED_CODE,
      generateSetupToken: () => `grant-${String(nowMs)}-${Math.random().toString(16).slice(2)}`,
    });
    const email = 'Two.Challenges+grants@example.com';
    const first = await currentApp().inject({
      method: 'POST',
      url: '/v1/account/email-verifications',
      payload: { email },
    });
    const firstId = first.json<{ data: { verificationId: string } }>().data.verificationId;
    await currentApp().inject({
      method: 'POST',
      url: '/v1/account/email-verifications/complete',
      payload: { verificationId: firstId, code: FIXED_CODE },
    });

    nowMs += 61_000;
    const second = await currentApp().inject({
      method: 'POST',
      url: '/v1/account/email-verifications',
      remoteAddress: '127.0.0.70',
      payload: { email },
    });
    const secondId = second.json<{ data: { verificationId: string } }>().data.verificationId;
    expect(secondId).not.toBe(firstId);

    // Force both challenges to look active (bypass revoke) to exercise completion race.
    await currentApp().database.db.execute(sql`
        UPDATE town.email_challenges
        SET revoked_at = NULL, consumed_at = NULL, attempt_count = 0
        WHERE id IN (${firstId}, ${secondId})
      `);

    const results = await Promise.all([
      currentApp().inject({
        method: 'POST',
        url: '/v1/account/email-verifications/complete',
        payload: { verificationId: firstId, code: FIXED_CODE },
      }),
      currentApp().inject({
        method: 'POST',
        url: '/v1/account/email-verifications/complete',
        payload: { verificationId: secondId, code: FIXED_CODE },
      }),
    ]);

    // First challenge was already consumed originally; reactivating it still cannot
    // leave two active grants after sequential account locks + revoke-before-create.
    const db = currentApp().database.db;
    const activeGrants = await db
      .select()
      .from(setupGrants)
      .where(sql`${setupGrants.revokedAt} is null and ${setupGrants.consumedAt} is null`);
    expect(activeGrants.length).toBeLessThanOrEqual(1);
    expect(results.every((response) => [200, 400].includes(response.statusCode))).toBe(true);
  });

  it('fails safely when account status changes during completion and creates no account', async () => {
    const email = 'State.Change+during@example.com';
    await currentApp().inject({
      method: 'POST',
      url: '/v1/account/email-verifications',
      payload: { email },
    });
    const challenge = await latestChallenge();
    const db = currentApp().database.db;
    const account = (await db.select().from(accounts))[0];
    expect(account).toBeDefined();
    if (account === undefined) {
      throw new Error('expected account');
    }
    await db
      .update(accounts)
      .set({
        status: 'closed',
        accountReadyAt: FIXED_NOW,
        closedAt: FIXED_NOW,
        webauthnUserHandle: Buffer.alloc(32, 3),
        updatedAt: FIXED_NOW,
      })
      .where(eq(accounts.id, account.id));

    const accountsBefore = (await db.select({ value: count() }).from(accounts))[0]?.value;
    const failed = await currentApp().inject({
      method: 'POST',
      url: '/v1/account/email-verifications/complete',
      payload: { verificationId: challenge.id, code: FIXED_CODE },
    });
    expect(failed.statusCode).toBe(400);
    expect((await db.select({ value: count() }).from(accounts))[0]?.value).toBe(accountsBefore);
    expect((await db.select({ value: count() }).from(setupGrants))[0]?.value).toBe(0);
  });
});

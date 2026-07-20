import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { count, eq } from 'drizzle-orm';
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
    expect(account?.status).toBe('pending_passkey');
    const emailRow = (await db.select().from(accountEmails))[0];
    expect(emailRow?.verifiedAt).not.toBeNull();
    expect((await db.select({ value: count() }).from(setupGrants))[0]?.value).toBe(1);
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
});

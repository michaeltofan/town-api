import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { signalConfirmations } from '../src/db/schema.js';
import {
  createLoginAccount,
  createSignal,
  ensureCommunity,
} from '../src/platform/capacity-drill/provisioning.js';
import { createMembershipTestApp } from './helpers/membership.js';
import { signInWithPassword } from './helpers/password-authentication.js';

const CAPACITY_HOST = 'town-api-capacity-capacity.up.railway.app';
const CAPACITY_ORIGIN = `https://${CAPACITY_HOST}`;
const COMMIT_SHA = '1234567890abcdef1234567890abcdef12345678';
const ACCOUNT_ID = '7ca00000-0000-4000-8000-000000000001';
const ACTOR_ID = '7ca00000-0000-4000-8000-000000000002';
const COMMUNITY_ID = '7ca00000-0000-4000-8000-000000000003';
const SIGNAL_ID = '7ca00000-0000-4000-8000-000000000004';
const PASSWORD = 'Capacity-Drill-Password-2026!';

/**
 * DB-backed capacity login path. Kept out of the parallel unit suite —
 * schema reset races there (relation "town.communities" does not exist).
 */
describe('capacity password login and authorized confirmation', () => {
  let context: Awaited<ReturnType<typeof createMembershipTestApp>> | undefined;

  beforeAll(async () => {
    context = await createMembershipTestApp({
      envOverrides: {
        NODE_ENV: 'production',
        APP_ENV: 'staging',
        RAILWAY_ENVIRONMENT_NAME: 'capacity',
        APP_COMMIT_SHA: COMMIT_SHA,
        PASSWORD_SIGN_IN_ENABLED: 'true',
        EMAIL_VERIFICATION_ENABLED: 'false',
        WEBAUTHN_REGISTRATION_ENABLED: 'false',
        WEBAUTHN_RP_ID: CAPACITY_HOST,
        WEBAUTHN_ALLOWED_ORIGINS: CAPACITY_ORIGIN,
        WEBAUTHN_CHALLENGE_HASH_KEY: 'capacity-webauthn-challenge-key-32-bytes',
        PASSKEY_AUTHENTICATION_CHALLENGE_HASH_KEY: 'capacity-passkey-authentication-key-32-bytes',
      },
    });

    const at = '2026-08-14T12:00:00.000Z';
    const community = await ensureCommunity(context.app.database.db, {
      id: COMMUNITY_ID,
      slug: 'capacity-policy-test',
      position: 9001,
      at,
    });
    await createSignal(context.app.database.db, {
      id: SIGNAL_ID,
      communityId: COMMUNITY_ID,
      slug: 'capacity-policy-signal',
      position: 1,
      at,
      index: 1,
    });
    await createLoginAccount(context.app.database.db, {
      accountId: ACCOUNT_ID,
      actorId: ACTOR_ID,
      email: 'capacity-policy-test@loadtest.internal',
      password: PASSWORD,
      communityId: COMMUNITY_ID,
      community,
      at,
    });
  });

  afterAll(async () => {
    if (!context) {
      return;
    }
    await context.app.close();
    await context.pool.end();
  });

  it('logs in with a password and writes an authorized confirmation', async () => {
    if (!context) {
      throw new Error('capacity test app was not initialized');
    }
    const login = await signInWithPassword({
      app: context.app,
      email: 'capacity-policy-test@loadtest.internal',
      password: PASSWORD,
      clientType: 'mobile',
    });
    expect(login.statusCode).toBe(200);
    const sessionToken = login.json<{ data: { sessionToken: string } }>().data.sessionToken;
    expect(sessionToken).toBeTruthy();

    const confirmation = await context.app.inject({
      method: 'PUT',
      url: `/v1/signals/${SIGNAL_ID}/confirmation`,
      headers: { authorization: `Session ${sessionToken}` },
      payload: {},
    });
    expect(confirmation.statusCode).toBe(200);
    expect(confirmation.json()).toMatchObject({
      data: { signalId: SIGNAL_ID, confirmed: true },
    });

    const rows = await context.app.database.db
      .select()
      .from(signalConfirmations)
      .where(eq(signalConfirmations.signalId, SIGNAL_ID));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actorId).toBe(ACTOR_ID);
  });
});

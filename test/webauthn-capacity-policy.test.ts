import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { requireAccountRecoveryConfig } from '../src/ceremony/account-recovery/config.js';
import { requirePasskeyAuthenticationConfig } from '../src/ceremony/passkey-authentication/config.js';
import { requirePasskeyManagementConfig } from '../src/ceremony/passkey-management/config.js';
import { requireWebAuthnRegistrationConfig } from '../src/ceremony/passkey-registration/config.js';
import { loadEnv } from '../src/config/env.js';
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
const DATABASE_URL = 'postgres://town:secret@db.internal:5432/town';
const ACCOUNT_ID = '7ca00000-0000-4000-8000-000000000001';
const ACTOR_ID = '7ca00000-0000-4000-8000-000000000002';
const COMMUNITY_ID = '7ca00000-0000-4000-8000-000000000003';
const SIGNAL_ID = '7ca00000-0000-4000-8000-000000000004';
const PASSWORD = 'Capacity-Drill-Password-2026!';

function capacityProcessEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    APP_ENV: 'staging',
    RAILWAY_ENVIRONMENT_NAME: 'capacity',
    APP_COMMIT_SHA: COMMIT_SHA,
    DATABASE_URL,
    PASSWORD_SIGN_IN_ENABLED: 'true',
    PASSKEY_AUTHENTICATION_ENABLED: 'true',
    WEBAUTHN_REGISTRATION_ENABLED: 'true',
    ACCOUNT_RECOVERY_ENABLED: 'true',
    ACCOUNT_RECOVERY_DELIVERY_MODE: 'resend',
    ACCOUNT_RECOVERY_HASH_KEY: 'capacity-recovery-hash-key-32-bytes-long',
    ACCOUNT_RECOVERY_TOKEN_HASH_KEY: 'capacity-recovery-token-key-32-bytes',
    EMAIL_VERIFICATION_RESEND_API_KEY: 're_capacity_environment_key_123456',
    EMAIL_VERIFICATION_FROM_ADDRESS: 'noreply@towncivic.org',
    EMAIL_VERIFICATION_HASH_KEY: 'capacity-email-verification-key-32-bytes',
    CEREMONY_RATE_LIMIT_HASH_KEY: 'capacity-rate-limit-hash-key-32-bytes',
    SESSION_TOKEN_HASH_KEY: 'capacity-session-token-hash-key-32-bytes',
    WEBAUTHN_CHALLENGE_HASH_KEY: 'capacity-webauthn-challenge-key-32-bytes',
    PASSKEY_AUTHENTICATION_CHALLENGE_HASH_KEY: 'capacity-passkey-authentication-key-32-bytes',
    WEBAUTHN_RP_ID: CAPACITY_HOST,
    WEBAUTHN_ALLOWED_ORIGINS: CAPACITY_ORIGIN,
    ...overrides,
  };
}

describe('WebAuthn deployment policy', () => {
  it('accepts the exact Railway capacity configuration in every WebAuthn runtime', () => {
    const env = loadEnv(capacityProcessEnv());

    expect(env.NODE_ENV).toBe('production');
    expect(env.APP_ENV).toBe('staging');
    for (const config of [
      requireWebAuthnRegistrationConfig(env),
      requirePasskeyAuthenticationConfig(env),
      requirePasskeyManagementConfig(env),
      requireAccountRecoveryConfig(env),
    ]) {
      expect(config.rpId).toBe(CAPACITY_HOST);
      expect(config.allowedOrigins).toEqual([CAPACITY_ORIGIN]);
    }
  });

  it('keeps Production restricted to towncivic.org', () => {
    const runtimeMisconfiguredProduction = {
      ...loadEnv(capacityProcessEnv()),
      APP_ENV: 'production' as const,
      WEBAUTHN_ALLOWED_ORIGINS: 'https://towncivic.org',
    };
    for (const resolve of [
      requireWebAuthnRegistrationConfig,
      requirePasskeyAuthenticationConfig,
      requirePasskeyManagementConfig,
      requireAccountRecoveryConfig,
    ]) {
      expect(() => resolve(runtimeMisconfiguredProduction)).toThrow(
        /production WEBAUTHN_RP_ID must be exactly towncivic\.org/,
      );
    }

    expect(() =>
      loadEnv(
        capacityProcessEnv({
          APP_ENV: 'production',
          DATABASE_URL: 'postgres://town:secret@production-db.internal:5432/town',
        }),
      ),
    ).toThrow(/production WEBAUTHN_RP_ID must be exactly towncivic\.org/);

    expect(() =>
      loadEnv(
        capacityProcessEnv({
          APP_ENV: 'production',
          DATABASE_URL: 'postgres://town:secret@production-db.internal:5432/town',
          WEBAUTHN_RP_ID: 'towncivic.org',
        }),
      ),
    ).toThrow(/production WEBAUTHN_ALLOWED_ORIGINS must be exactly https:\/\/towncivic\.org/);

    const production = loadEnv(
      capacityProcessEnv({
        APP_ENV: 'production',
        DATABASE_URL: 'postgres://town:secret@production-db.internal:5432/town',
        WEBAUTHN_RP_ID: 'towncivic.org',
        WEBAUTHN_ALLOWED_ORIGINS: 'https://towncivic.org',
      }),
    );
    for (const config of [
      requireWebAuthnRegistrationConfig(production),
      requirePasskeyAuthenticationConfig(production),
      requirePasskeyManagementConfig(production),
      requireAccountRecoveryConfig(production),
    ]) {
      expect(config.rpId).toBe('towncivic.org');
      expect(config.allowedOrigins).toEqual(['https://towncivic.org']);
    }
  });

  it('rejects localhost and HTTP in capacity while preserving normal HTTPS Staging', () => {
    expect(() =>
      loadEnv(
        capacityProcessEnv({
          WEBAUTHN_RP_ID: 'localhost',
          WEBAUTHN_ALLOWED_ORIGINS: 'http://localhost:3000',
        }),
      ),
    ).toThrow(/staging.*localhost/);

    expect(() =>
      loadEnv(
        capacityProcessEnv({
          WEBAUTHN_ALLOWED_ORIGINS: `http://${CAPACITY_HOST}`,
        }),
      ),
    ).toThrow(/staging.*https/);

    const staging = loadEnv(
      capacityProcessEnv({
        RAILWAY_ENVIRONMENT_NAME: 'staging',
        WEBAUTHN_RP_ID: 'staging.towncivic.org',
        WEBAUTHN_ALLOWED_ORIGINS: 'https://staging.towncivic.org',
      }),
    );
    expect(requirePasskeyAuthenticationConfig(staging).allowedOrigins).toEqual([
      'https://staging.towncivic.org',
    ]);
  });
});

describe('capacity password login and authorized confirmation', () => {
  let context: Awaited<ReturnType<typeof createMembershipTestApp>>;

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
    await context.app.close();
    await context.pool.end();
  });

  it('logs in with a password and writes an authorized confirmation', async () => {
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

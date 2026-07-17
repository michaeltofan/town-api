import { and, desc, eq, isNull } from 'drizzle-orm';
import { Pool } from 'pg';
import { buildApp, type AppInstance } from '../../src/app.js';
import { createInMemoryTestRecoveryDeliveryAdapter } from '../../src/ceremony/account-recovery/delivery.js';
import { createInMemoryTestDeliveryAdapter } from '../../src/ceremony/email-verification/delivery.js';
import { loadEnv, type Env } from '../../src/config/env.js';
import { createDatabase } from '../../src/db/client.js';
import { accounts, emailChallenges, passkeyCredentials } from '../../src/db/schema.js';
import { requireDatabaseUrl, resetMigrateSeedFoundationAndActor } from './pg.js';
import {
  authenticatePasskey,
  createPasskeyAuthenticationEnv,
  registerActivePasskeyAccount,
  TEST_CEREMONY_RATE_LIMIT_HASH_KEY,
  TEST_EMAIL_VERIFICATION_HASH_KEY,
  TEST_ORIGIN,
  TEST_PASSKEY_AUTHENTICATION_CHALLENGE_HASH_KEY,
  TEST_RP_ID,
  TEST_SESSION_TOKEN_HASH_KEY,
  TEST_WEBAUTHN_CHALLENGE_HASH_KEY,
  TEST_WEB_SESSION_COOKIE_NAME,
} from './passkey-authentication.js';
import {
  createSoftPasskeyMaterial,
  type SoftPasskeyMaterial,
} from './webauthn-soft-authenticator.js';

export {
  TEST_CEREMONY_RATE_LIMIT_HASH_KEY,
  TEST_EMAIL_VERIFICATION_HASH_KEY,
  TEST_ORIGIN,
  TEST_RP_ID,
  TEST_WEBAUTHN_CHALLENGE_HASH_KEY,
};

export const TEST_ACCOUNT_RECOVERY_HASH_KEY = 'town-ci-account-recovery-hash-key-32byt';
export const TEST_ACCOUNT_RECOVERY_TOKEN_HASH_KEY = 'town-ci-account-recovery-token-key-32b';
export const FIXED_RECOVERY_CODE = '654321';

export function createAccountRecoveryEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): Env {
  return loadEnv({
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: '3000',
    LOG_LEVEL: 'silent',
    DATABASE_URL: requireDatabaseUrl(),
    DB_POOL_MAX: '5',
    DB_CONNECTION_TIMEOUT_MS: '3000',
    DB_IDLE_TIMEOUT_MS: '1000',
    CONTROLLED_CONFIRMATION_ENABLED: 'false',
    EMAIL_VERIFICATION_ENABLED: 'true',
    EMAIL_VERIFICATION_HASH_KEY: TEST_EMAIL_VERIFICATION_HASH_KEY,
    CEREMONY_RATE_LIMIT_HASH_KEY: TEST_CEREMONY_RATE_LIMIT_HASH_KEY,
    EMAIL_VERIFICATION_DELIVERY_MODE: 'test',
    WEBAUTHN_REGISTRATION_ENABLED: 'true',
    WEBAUTHN_RP_ID: TEST_RP_ID,
    WEBAUTHN_RP_NAME: 'TOWN',
    WEBAUTHN_ALLOWED_ORIGINS: TEST_ORIGIN,
    WEBAUTHN_CHALLENGE_HASH_KEY: TEST_WEBAUTHN_CHALLENGE_HASH_KEY,
    PASSKEY_AUTHENTICATION_ENABLED: 'true',
    PASSKEY_AUTHENTICATION_CHALLENGE_HASH_KEY: TEST_PASSKEY_AUTHENTICATION_CHALLENGE_HASH_KEY,
    SESSION_TOKEN_HASH_KEY: TEST_SESSION_TOKEN_HASH_KEY,
    WEB_SESSION_COOKIE_NAME: TEST_WEB_SESSION_COOKIE_NAME,
    ACCOUNT_RECOVERY_ENABLED: 'true',
    ACCOUNT_RECOVERY_HASH_KEY: TEST_ACCOUNT_RECOVERY_HASH_KEY,
    ACCOUNT_RECOVERY_TOKEN_HASH_KEY: TEST_ACCOUNT_RECOVERY_TOKEN_HASH_KEY,
    ACCOUNT_RECOVERY_DELIVERY_MODE: 'test',
    TRUST_PROXY: 'false',
    ...overrides,
  });
}

export async function createAccountRecoveryTestApp(options?: {
  enabled?: boolean;
  now?: () => string;
  generateCode?: () => string;
  generateRecoveryToken?: () => string;
  generateId?: () => string;
}): Promise<{
  app: AppInstance;
  pool: Pool;
  env: Env;
  emailDelivery: ReturnType<typeof createInMemoryTestDeliveryAdapter>;
  recoveryDelivery: ReturnType<typeof createInMemoryTestRecoveryDeliveryAdapter>;
}> {
  const databaseUrl = requireDatabaseUrl();
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  await resetMigrateSeedFoundationAndActor(pool);

  const enabled = options?.enabled ?? true;
  const env = createAccountRecoveryEnv(
    enabled
      ? {}
      : {
          ACCOUNT_RECOVERY_ENABLED: 'false',
        },
  );
  const emailDelivery = createInMemoryTestDeliveryAdapter();
  const recoveryDelivery = createInMemoryTestRecoveryDeliveryAdapter();
  const database = createDatabase({
    connectionString: env.DATABASE_URL,
    poolMax: env.DB_POOL_MAX,
    connectionTimeoutMs: env.DB_CONNECTION_TIMEOUT_MS,
    idleTimeoutMs: env.DB_IDLE_TIMEOUT_MS,
  });

  const app = await buildApp({
    env,
    logger: false,
    database,
    emailVerification: {
      deliveryAdapter: emailDelivery,
      ...(options?.now !== undefined ? { now: options.now } : {}),
      ...(options?.generateId !== undefined ? { generateId: options.generateId } : {}),
    },
    accountRecovery: {
      deliveryAdapter: recoveryDelivery,
      ...(options?.now !== undefined ? { now: options.now } : {}),
      ...(options?.generateCode !== undefined ? { generateCode: options.generateCode } : {}),
      ...(options?.generateRecoveryToken !== undefined
        ? { generateRecoveryToken: options.generateRecoveryToken }
        : {}),
      ...(options?.generateId !== undefined ? { generateId: options.generateId } : {}),
    },
    passkeyRegistration: {
      ...(options?.now !== undefined ? { now: options.now } : {}),
      ...(options?.generateId !== undefined ? { generateId: options.generateId } : {}),
    },
    passkeyAuthentication: {
      ...(options?.now !== undefined ? { now: options.now } : {}),
      ...(options?.generateId !== undefined ? { generateId: options.generateId } : {}),
    },
  });
  await app.ready();

  return { app, pool, env, emailDelivery, recoveryDelivery };
}

export async function registerActiveAccountForRecovery(
  app: AppInstance,
  emailDelivery: ReturnType<typeof createInMemoryTestDeliveryAdapter>,
  email = 'Recovery.User+setup@example.com',
): Promise<{
  accountId: string;
  email: string;
  material: SoftPasskeyMaterial;
  userHandle: Uint8Array;
}> {
  const registered = await registerActivePasskeyAccount(app, emailDelivery, email);
  return {
    accountId: registered.accountId,
    email,
    material: registered.material,
    userHandle: registered.userHandle,
  };
}

export async function latestRecoveryChallenge(app: AppInstance, accountId: string) {
  const rows = await app.database.db
    .select()
    .from(emailChallenges)
    .where(
      and(eq(emailChallenges.accountId, accountId), eq(emailChallenges.purpose, 'recover_account')),
    )
    .orderBy(desc(emailChallenges.createdAt))
    .limit(1);
  const challenge = rows[0];
  if (!challenge) {
    throw new Error('expected recover_account challenge');
  }
  return challenge;
}

export async function requestRecovery(
  app: AppInstance,
  email: string,
  options?: { remoteAddress?: string; locale?: string },
) {
  return app.inject({
    method: 'POST',
    url: '/v1/account/recovery',
    ...(options?.remoteAddress !== undefined ? { remoteAddress: options.remoteAddress } : {}),
    payload: {
      email,
      ...(options?.locale !== undefined ? { locale: options.locale } : {}),
    },
  });
}

export async function verifyRecoveryEmailRequest(
  app: AppInstance,
  input: { recoveryVerificationId: string; code: string; remoteAddress?: string },
) {
  return app.inject({
    method: 'POST',
    url: '/v1/account/recovery/verify-email',
    ...(input.remoteAddress !== undefined ? { remoteAddress: input.remoteAddress } : {}),
    payload: {
      recoveryVerificationId: input.recoveryVerificationId,
      code: input.code,
    },
  });
}

export async function completeRecoveryWithNewPasskey(input: {
  app: AppInstance;
  recoveryGrant: string;
  existingUserHandle: Uint8Array;
  material?: SoftPasskeyMaterial;
}) {
  const material = input.material ?? createSoftPasskeyMaterial();
  const optionsResponse = await input.app.inject({
    method: 'POST',
    url: '/v1/account/recovery/passkeys/registration/options',
    headers: { authorization: `RecoveryGrant ${input.recoveryGrant}` },
    payload: {},
  });
  if (optionsResponse.statusCode !== 200) {
    throw new Error(
      `recovery options failed with status ${String(optionsResponse.statusCode)}: ${optionsResponse.body}`,
    );
  }
  const optionsBody = optionsResponse.json<{
    data: {
      recoveryCeremonyId: string;
      options: {
        challenge: string;
        user: { id: string };
        excludeCredentials?: { id: string }[];
      };
    };
  }>();

  const verifyResponse = await input.app.inject({
    method: 'POST',
    url: '/v1/account/recovery/passkeys/registration/verify',
    headers: { authorization: `RecoveryGrant ${input.recoveryGrant}` },
    payload: {
      recoveryCeremonyId: optionsBody.data.recoveryCeremonyId,
      response: material.createRegistrationResponse({
        challenge: optionsBody.data.options.challenge,
        rpID: TEST_RP_ID,
        origin: TEST_ORIGIN,
      }),
    },
  });

  return { optionsResponse, optionsBody, verifyResponse, material };
}

export async function countActivePasskeys(app: AppInstance, accountId: string): Promise<number> {
  const rows = await app.database.db
    .select()
    .from(passkeyCredentials)
    .where(and(eq(passkeyCredentials.accountId, accountId), isNull(passkeyCredentials.revokedAt)));
  return rows.length;
}

export async function getAccount(app: AppInstance, accountId: string) {
  const rows = await app.database.db
    .select()
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  return rows[0] ?? null;
}

export { authenticatePasskey, createPasskeyAuthenticationEnv, createSoftPasskeyMaterial };

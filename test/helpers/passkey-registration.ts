import { desc, eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { buildApp, type AppInstance } from '../../src/app.js';
import { createInMemoryTestDeliveryAdapter } from '../../src/ceremony/email-verification/delivery.js';
import { loadEnv, type Env } from '../../src/config/env.js';
import { createDatabase } from '../../src/db/client.js';
import { accountEmails, emailChallenges } from '../../src/db/schema.js';
import { normalizeEmail } from '../../src/identity/email-normalize.js';
import { requireDatabaseUrl, resetMigrateSeedFoundationAndActor } from './pg.js';

export const TEST_EMAIL_VERIFICATION_HASH_KEY = 'town-ci-email-verification-hash-key-32b';
export const TEST_CEREMONY_RATE_LIMIT_HASH_KEY = 'town-ci-ceremony-rate-limit-hash-key-32b';
export const TEST_WEBAUTHN_CHALLENGE_HASH_KEY = 'town-ci-webauthn-challenge-hash-key-32by';
export const TEST_RP_ID = 'localhost';
export const TEST_ORIGIN = 'http://localhost:3000';
export const TEST_INITIAL_PASSWORD = 'correct-horse-battery';

export function createPasskeyRegistrationEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): Env {
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
    PASSWORD_AUTH_ENABLED: 'true',
    WEBAUTHN_REGISTRATION_ENABLED: 'true',
    WEBAUTHN_RP_ID: TEST_RP_ID,
    WEBAUTHN_RP_NAME: 'TOWN',
    WEBAUTHN_ALLOWED_ORIGINS: TEST_ORIGIN,
    WEBAUTHN_CHALLENGE_HASH_KEY: TEST_WEBAUTHN_CHALLENGE_HASH_KEY,
    TRUST_PROXY: 'false',
    ...overrides,
  });
}

export async function createPasskeyRegistrationTestApp(options?: {
  enabled?: boolean;
  passwordEnabled?: boolean;
  now?: () => string;
  generateId?: () => string;
}): Promise<{
  app: AppInstance;
  pool: Pool;
  env: Env;
  delivery: ReturnType<typeof createInMemoryTestDeliveryAdapter>;
}> {
  const databaseUrl = requireDatabaseUrl();
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  await resetMigrateSeedFoundationAndActor(pool);

  const enabled = options?.enabled ?? true;
  const passwordEnabled = options?.passwordEnabled ?? true;
  const env = createPasskeyRegistrationEnv({
    ...(enabled ? {} : { WEBAUTHN_REGISTRATION_ENABLED: 'false' }),
    ...(passwordEnabled ? {} : { PASSWORD_AUTH_ENABLED: 'false' }),
  });
  const delivery = createInMemoryTestDeliveryAdapter();
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
      deliveryAdapter: delivery,
      ...(options?.now !== undefined ? { now: options.now } : {}),
      ...(options?.generateId !== undefined ? { generateId: options.generateId } : {}),
    },
    passwordSetup: {
      ...(options?.now !== undefined ? { now: options.now } : {}),
      ...(options?.generateId !== undefined ? { generateId: options.generateId } : {}),
    },
    passkeyRegistration: {
      ...(options?.now !== undefined ? { now: options.now } : {}),
      ...(options?.generateId !== undefined ? { generateId: options.generateId } : {}),
    },
  });
  await app.ready();

  return { app, pool, env, delivery };
}

/** Completes email verification and returns the initial_password_setup grant. */
export async function completeEmailSetup(
  app: AppInstance,
  delivery: ReturnType<typeof createInMemoryTestDeliveryAdapter>,
  email: string,
): Promise<{ setupGrant: string; accountId: string }> {
  await app.inject({
    method: 'POST',
    url: '/v1/account/email-verifications',
    payload: { email },
  });

  const normalized = normalizeEmail(email);
  const challenge = (
    await app.database.db
      .select()
      .from(emailChallenges)
      .where(eq(emailChallenges.emailNormalized, normalized))
      .orderBy(desc(emailChallenges.createdAt))
      .limit(1)
  )[0];
  if (!challenge) {
    throw new Error('expected email verification challenge');
  }
  const delivered = [...delivery.records].reverse().find((record) => record.email === email);
  if (!delivered) {
    throw new Error('expected delivered verification code');
  }

  const completed = await app.inject({
    method: 'POST',
    url: '/v1/account/email-verifications/complete',
    payload: { verificationId: challenge.id, code: delivered.code },
  });
  if (completed.statusCode !== 200) {
    throw new Error(`email setup failed with status ${String(completed.statusCode)}`);
  }

  const accountEmail = (
    await app.database.db
      .select()
      .from(accountEmails)
      .where(eq(accountEmails.emailNormalized, normalized))
      .limit(1)
  )[0];
  if (!accountEmail) {
    throw new Error('expected account email');
  }

  return {
    setupGrant: completed.json<{ data: { setupGrant: string } }>().data.setupGrant,
    accountId: accountEmail.accountId,
  };
}

/** Completes initial password setup and returns the initial_passkey_registration grant. */
export async function completePasswordSetup(
  app: AppInstance,
  passwordSetupGrant: string,
  password: string = TEST_INITIAL_PASSWORD,
): Promise<{ setupGrant: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/account/password',
    headers: { authorization: `SetupGrant ${passwordSetupGrant}` },
    payload: { password },
  });
  if (response.statusCode !== 200) {
    throw new Error(
      `password setup failed with status ${String(response.statusCode)}: ${response.body}`,
    );
  }
  return {
    setupGrant: response.json<{ data: { setupGrant: string } }>().data.setupGrant,
  };
}

/** Email verify + password setup → passkey SetupGrant for first-passkey registration. */
export async function completeEmailAndPasswordSetup(
  app: AppInstance,
  delivery: ReturnType<typeof createInMemoryTestDeliveryAdapter>,
  email: string,
  password: string = TEST_INITIAL_PASSWORD,
): Promise<{ setupGrant: string; accountId: string }> {
  const emailSetup = await completeEmailSetup(app, delivery, email);
  const passwordSetup = await completePasswordSetup(app, emailSetup.setupGrant, password);
  return {
    setupGrant: passwordSetup.setupGrant,
    accountId: emailSetup.accountId,
  };
}

import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { buildApp, type AppInstance } from '../../src/app.js';
import { createInMemoryTestDeliveryAdapter } from '../../src/ceremony/email-verification/delivery.js';
import { loadEnv, type Env } from '../../src/config/env.js';
import { createDatabase } from '../../src/db/client.js';
import { accounts } from '../../src/db/schema.js';
import { requireDatabaseUrl, resetMigrateSeedFoundationAndActor } from './pg.js';
import {
  completeEmailSetup,
  TEST_CEREMONY_RATE_LIMIT_HASH_KEY,
  TEST_EMAIL_VERIFICATION_HASH_KEY,
  TEST_ORIGIN,
  TEST_RP_ID,
  TEST_WEBAUTHN_CHALLENGE_HASH_KEY,
} from './passkey-registration.js';
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

export const TEST_PASSKEY_AUTHENTICATION_CHALLENGE_HASH_KEY =
  'town-ci-passkey-auth-challenge-hash-key32';
export const TEST_SESSION_TOKEN_HASH_KEY = 'town-ci-session-token-hash-key-32bytesxx';
export const TEST_WEB_SESSION_COOKIE_NAME = '__Host-Http-town_session';
export const TEST_ANONYMOUS_CLIENT_KEY = 'anonymous-client-key-0001';

export function createPasskeyAuthenticationEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): Env {
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
    TRUST_PROXY: 'false',
    ...overrides,
  });
}

export async function createPasskeyAuthenticationTestApp(options?: {
  enabled?: boolean;
  now?: () => string;
  generateId?: () => string;
  generateToken?: () => string;
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
  const env = createPasskeyAuthenticationEnv(
    enabled
      ? {}
      : {
          PASSKEY_AUTHENTICATION_ENABLED: 'false',
        },
  );
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
    passkeyRegistration: {
      ...(options?.now !== undefined ? { now: options.now } : {}),
      ...(options?.generateId !== undefined ? { generateId: options.generateId } : {}),
    },
    passkeyAuthentication: {
      ...(options?.now !== undefined ? { now: options.now } : {}),
      ...(options?.generateId !== undefined ? { generateId: options.generateId } : {}),
      ...(options?.generateToken !== undefined ? { generateToken: options.generateToken } : {}),
    },
  });
  await app.ready();

  return { app, pool, env, delivery };
}

export async function registerActivePasskeyAccount(
  app: AppInstance,
  delivery: ReturnType<typeof createInMemoryTestDeliveryAdapter>,
  email = 'Passkey.Auth+setup@example.com',
): Promise<{
  accountId: string;
  setupGrant: string;
  material: SoftPasskeyMaterial;
  userHandle: Uint8Array;
}> {
  const setup = await completeEmailSetup(app, delivery, email);
  const optionsResponse = await app.inject({
    method: 'POST',
    url: '/v1/account/passkeys/registration/options',
    headers: { authorization: `SetupGrant ${setup.setupGrant}` },
    payload: {},
  });
  if (optionsResponse.statusCode !== 200) {
    throw new Error(
      `registration options failed with status ${String(optionsResponse.statusCode)}`,
    );
  }

  const options = optionsResponse.json<{
    data: {
      registrationCeremonyId: string;
      options: { challenge: string; user: { id: string } };
    };
  }>();
  const userHandle = Buffer.from(options.data.options.user.id, 'base64url');
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
  if (verifyResponse.statusCode !== 200) {
    throw new Error(`registration verify failed with status ${String(verifyResponse.statusCode)}`);
  }

  const account = (
    await app.database.db.select().from(accounts).where(eq(accounts.id, setup.accountId)).limit(1)
  )[0];
  if (account?.status !== 'active') {
    throw new Error('expected active account after passkey registration');
  }

  return {
    accountId: setup.accountId,
    setupGrant: setup.setupGrant,
    material,
    userHandle,
  };
}

export async function authenticatePasskey(input: {
  app: AppInstance;
  material: SoftPasskeyMaterial;
  clientType: 'web' | 'mobile';
  anonymousClientKey?: string;
  signCount?: number;
  origin?: string;
  rpID?: string;
  userVerified?: boolean;
  userHandle?: Uint8Array;
  remoteAddress?: string;
}) {
  const optionsResponse = await input.app.inject({
    method: 'POST',
    url: '/v1/authentication/passkeys/options',
    ...(input.remoteAddress !== undefined ? { remoteAddress: input.remoteAddress } : {}),
    payload: {
      clientType: input.clientType,
      anonymousClientKey: input.anonymousClientKey ?? TEST_ANONYMOUS_CLIENT_KEY,
    },
  });
  if (optionsResponse.statusCode !== 200) {
    throw new Error(
      `authentication options failed with status ${String(optionsResponse.statusCode)}`,
    );
  }

  const options = optionsResponse.json<{
    data: { authenticationCeremonyId: string; options: { challenge: string } };
  }>();
  const verifyResponse = await input.app.inject({
    method: 'POST',
    url: '/v1/authentication/passkeys/verify',
    ...(input.remoteAddress !== undefined ? { remoteAddress: input.remoteAddress } : {}),
    payload: {
      authenticationCeremonyId: options.data.authenticationCeremonyId,
      clientType: input.clientType,
      response: input.material.createAuthenticationResponse({
        challenge: options.data.options.challenge,
        rpID: input.rpID ?? TEST_RP_ID,
        origin: input.origin ?? TEST_ORIGIN,
        userVerified: input.userVerified ?? true,
        signCount: input.signCount ?? 1,
        ...(input.userHandle !== undefined ? { userHandle: input.userHandle } : {}),
      }),
    },
  });

  return { optionsResponse, verifyResponse, options };
}

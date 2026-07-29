import { Pool } from 'pg';
import { buildApp, type AppInstance } from '../../src/app.js';
import { createInMemoryTestDeliveryAdapter } from '../../src/ceremony/email-verification/delivery.js';
import { loadEnv, type Env } from '../../src/config/env.js';
import { createDatabase } from '../../src/db/client.js';
import {
  createPasskeyAuthenticationEnv,
  registerActivePasskeyAccount,
  TEST_CEREMONY_RATE_LIMIT_HASH_KEY,
  TEST_SESSION_TOKEN_HASH_KEY,
  TEST_WEB_SESSION_COOKIE_NAME,
} from './passkey-authentication.js';
import { TEST_INITIAL_PASSWORD } from './passkey-registration.js';
import { requireDatabaseUrl, resetMigrateSeedFoundationAndActor } from './pg.js';

export {
  TEST_CEREMONY_RATE_LIMIT_HASH_KEY,
  TEST_INITIAL_PASSWORD,
  TEST_SESSION_TOKEN_HASH_KEY,
  TEST_WEB_SESSION_COOKIE_NAME,
  registerActivePasskeyAccount,
};

export function createPasswordSignInEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): Env {
  return createPasskeyAuthenticationEnv({
    PASSWORD_SIGN_IN_ENABLED: 'true',
    ...overrides,
  });
}

export async function createPasswordSignInTestApp(options?: {
  passwordSignInEnabled?: boolean;
  passkeyAuthenticationEnabled?: boolean;
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

  const passwordSignInEnabled = options?.passwordSignInEnabled ?? true;
  const passkeyAuthenticationEnabled = options?.passkeyAuthenticationEnabled ?? true;
  const env = createPasswordSignInEnv({
    ...(passwordSignInEnabled ? {} : { PASSWORD_SIGN_IN_ENABLED: 'false' }),
    ...(passkeyAuthenticationEnabled ? {} : { PASSKEY_AUTHENTICATION_ENABLED: 'false' }),
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
    passwordAuthentication: {
      ...(options?.now !== undefined ? { now: options.now } : {}),
      ...(options?.generateId !== undefined ? { generateId: options.generateId } : {}),
      ...(options?.generateToken !== undefined ? { generateToken: options.generateToken } : {}),
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

export async function signInWithPassword(input: {
  app: AppInstance;
  email: string;
  password?: string;
  clientType: 'web' | 'mobile';
  remoteAddress?: string;
}) {
  return input.app.inject({
    method: 'POST',
    url: '/v1/authentication/password',
    ...(input.remoteAddress !== undefined ? { remoteAddress: input.remoteAddress } : {}),
    payload: {
      email: input.email,
      password: input.password ?? TEST_INITIAL_PASSWORD,
      clientType: input.clientType,
    },
  });
}

/** Minimal env loader check that password sign-in defaults remain fail-closed. */
export function loadPasswordSignInDefaultEnv(): Env {
  return loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: requireDatabaseUrl(),
  });
}

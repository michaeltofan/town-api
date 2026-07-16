import { createInMemoryTestDeliveryAdapter } from '../../src/ceremony/email-verification/delivery.js';
import { loadEnv, type Env } from '../../src/config/env.js';
import { createDatabase } from '../../src/db/client.js';
import { buildApp, type AppInstance } from '../../src/app.js';
import { requireDatabaseUrl, resetMigrateSeedFoundationAndActor } from './pg.js';
import { Pool } from 'pg';

export const TEST_EMAIL_VERIFICATION_HASH_KEY = 'town-ci-email-verification-hash-key-32b';
export const TEST_CEREMONY_RATE_LIMIT_HASH_KEY = 'town-ci-ceremony-rate-limit-hash-key-32b';

export function createEmailVerificationEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): Env {
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
    TRUST_PROXY: 'false',
    ...overrides,
  });
}

export async function createEmailVerificationTestApp(options?: {
  enabled?: boolean;
  now?: () => string;
  generateCode?: () => string;
  generateSetupToken?: () => string;
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
  const env = createEmailVerificationEnv(
    enabled
      ? {}
      : {
          EMAIL_VERIFICATION_ENABLED: 'false',
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
      ...(options?.generateCode !== undefined ? { generateCode: options.generateCode } : {}),
      ...(options?.generateSetupToken !== undefined
        ? { generateSetupToken: options.generateSetupToken }
        : {}),
      ...(options?.generateId !== undefined ? { generateId: options.generateId } : {}),
    },
  });
  await app.ready();

  return { app, pool, env, delivery };
}

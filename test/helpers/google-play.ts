import { Pool } from 'pg';
import { buildApp, type AppInstance } from '../../src/app.js';
import { createInMemoryTestDeliveryAdapter } from '../../src/ceremony/email-verification/delivery.js';
import { loadEnv, type Env } from '../../src/config/env.js';
import { createDatabase } from '../../src/db/client.js';
import {
  createFakeGooglePlayAndroidPublisherAdapter,
  createFakeGooglePlayAndroidPublisherState,
  setFakeGooglePlaySubscription,
  type FakeGooglePlayAndroidPublisherState,
  type TownGooglePlayAndroidPublisherAdapter,
} from '../../src/membership/google-play/android-publisher-adapter.js';
import { requireDatabaseUrl, resetMigrateSeedFoundationAndActor } from './pg.js';
import {
  TEST_CEREMONY_RATE_LIMIT_HASH_KEY,
  TEST_EMAIL_VERIFICATION_HASH_KEY,
  TEST_ORIGIN,
  TEST_RP_ID,
  TEST_WEBAUTHN_CHALLENGE_HASH_KEY,
} from './passkey-registration.js';
import {
  TEST_PASSKEY_AUTHENTICATION_CHALLENGE_HASH_KEY,
  TEST_SESSION_TOKEN_HASH_KEY,
  TEST_WEB_SESSION_COOKIE_NAME,
} from './passkey-authentication.js';

export const TEST_GOOGLE_PLAY_PACKAGE_NAME = 'com.town.town_safe_space_mobile';
export const TEST_GOOGLE_PLAY_SUBSCRIPTION_ID = 'town_annual_membership';
export const TEST_GOOGLE_PLAY_SERVICE_ACCOUNT_JSON = JSON.stringify({
  type: 'service_account',
  client_email: 'play-api@example.iam.gserviceaccount.com',
  private_key:
    '-----BEGIN PRIVATE KEY-----\nREPLACE_WITH_LOCAL_PLACEHOLDER_KEY_MATERIAL\n-----END PRIVATE KEY-----\n',
});

export function createGooglePlayEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): Env {
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
    GOOGLE_PLAY_BILLING_ENABLED: 'true',
    GOOGLE_PLAY_PACKAGE_NAME: TEST_GOOGLE_PLAY_PACKAGE_NAME,
    GOOGLE_PLAY_SUBSCRIPTION_ID: TEST_GOOGLE_PLAY_SUBSCRIPTION_ID,
    GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: TEST_GOOGLE_PLAY_SERVICE_ACCOUNT_JSON,
    TRUST_PROXY: 'false',
    ...overrides,
  });
}

export type GooglePlayTestApp = {
  app: AppInstance;
  pool: Pool;
  env: Env;
  delivery: ReturnType<typeof createInMemoryTestDeliveryAdapter>;
  googlePlayState: FakeGooglePlayAndroidPublisherState;
  googlePlayAdapter: TownGooglePlayAndroidPublisherAdapter;
};

export type CreateGooglePlayTestAppOptions = {
  billingEnabled?: boolean;
  now?: () => string;
  generateId?: () => string;
  generateToken?: () => string;
};

export async function createGooglePlayTestApp(
  options: CreateGooglePlayTestAppOptions = {},
): Promise<GooglePlayTestApp> {
  const databaseUrl = requireDatabaseUrl();
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  await resetMigrateSeedFoundationAndActor(pool);

  const billingEnabled = options.billingEnabled ?? true;
  const env = createGooglePlayEnv(billingEnabled ? {} : { GOOGLE_PLAY_BILLING_ENABLED: 'false' });
  const delivery = createInMemoryTestDeliveryAdapter();
  const googlePlayState = createFakeGooglePlayAndroidPublisherState();
  const googlePlayAdapter = createFakeGooglePlayAndroidPublisherAdapter(googlePlayState);

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
    googlePlayAdapter,
    emailVerification: {
      deliveryAdapter: delivery,
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.generateId !== undefined ? { generateId: options.generateId } : {}),
    },
    passkeyRegistration: {
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.generateId !== undefined ? { generateId: options.generateId } : {}),
    },
    passkeyAuthentication: {
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.generateId !== undefined ? { generateId: options.generateId } : {}),
      ...(options.generateToken !== undefined ? { generateToken: options.generateToken } : {}),
    },
    passkeyManagement: {
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.generateId !== undefined ? { generateId: options.generateId } : {}),
      ...(options.generateToken !== undefined ? { generateToken: options.generateToken } : {}),
    },
    googlePlay: {
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.generateId !== undefined ? { generateId: options.generateId } : {}),
    },
  });
  await app.ready();

  return { app, pool, env, delivery, googlePlayState, googlePlayAdapter };
}

export function seedActiveGooglePlayPurchase(
  state: FakeGooglePlayAndroidPublisherState,
  input: {
    purchaseToken: string;
    packageName?: string;
    subscriptionId?: string;
    expiryTime?: string;
  },
): void {
  setFakeGooglePlaySubscription(state, {
    packageName: input.packageName ?? TEST_GOOGLE_PLAY_PACKAGE_NAME,
    purchaseToken: input.purchaseToken,
    purchase: {
      subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
      lineItems: [
        {
          productId: input.subscriptionId ?? TEST_GOOGLE_PLAY_SUBSCRIPTION_ID,
          expiryTime: input.expiryTime ?? '2027-07-25T12:00:00.000Z',
        },
      ],
    },
  });
}

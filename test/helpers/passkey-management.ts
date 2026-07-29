import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { buildApp, type AppInstance } from '../../src/app.js';
import { createInMemoryTestDeliveryAdapter } from '../../src/ceremony/email-verification/delivery.js';
import type { Env } from '../../src/config/env.js';
import { createDatabase } from '../../src/db/client.js';
import { accounts, passkeyCredentials } from '../../src/db/schema.js';
import { requireDatabaseUrl, resetMigrateSeedFoundationAndActor } from './pg.js';
import {
  authenticatePasskey,
  createPasskeyAuthenticationEnv,
  registerActivePasskeyAccount,
  TEST_ANONYMOUS_CLIENT_KEY,
  TEST_ORIGIN,
  TEST_RP_ID,
  TEST_WEB_SESSION_COOKIE_NAME,
} from './passkey-authentication.js';
import {
  createSoftPasskeyMaterial,
  type SoftPasskeyMaterial,
} from './webauthn-soft-authenticator.js';

export {
  TEST_ANONYMOUS_CLIENT_KEY,
  TEST_ORIGIN,
  TEST_RP_ID,
  TEST_WEB_SESSION_COOKIE_NAME,
  authenticatePasskey,
  createPasskeyAuthenticationEnv,
  registerActivePasskeyAccount,
};

export async function createPasskeyManagementTestApp(options?: {
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
    passwordSetup: {
      ...(options?.now !== undefined ? { now: options.now } : {}),
      ...(options?.generateId !== undefined ? { generateId: options.generateId } : {}),
    },
    passkeyRegistration: {
      ...(options?.now !== undefined ? { now: options.now } : {}),
      ...(options?.generateId !== undefined ? { generateId: options.generateId } : {}),
      ...(options?.generateToken !== undefined ? { generateToken: options.generateToken } : {}),
    },
    passkeyAuthentication: {
      ...(options?.now !== undefined ? { now: options.now } : {}),
      ...(options?.generateId !== undefined ? { generateId: options.generateId } : {}),
      ...(options?.generateToken !== undefined ? { generateToken: options.generateToken } : {}),
    },
    passkeyManagement: {
      ...(options?.now !== undefined ? { now: options.now } : {}),
      ...(options?.generateId !== undefined ? { generateId: options.generateId } : {}),
      ...(options?.generateToken !== undefined ? { generateToken: options.generateToken } : {}),
    },
  });
  await app.ready();

  return { app, pool, env, delivery };
}

export async function loginMobileSession(input: {
  app: AppInstance;
  material: SoftPasskeyMaterial;
  userHandle?: Uint8Array;
  anonymousClientKey?: string;
  signCount?: number;
}): Promise<{ sessionToken: string; sessionExpiresAt: string }> {
  const auth = await authenticatePasskey({
    app: input.app,
    material: input.material,
    clientType: 'mobile',
    ...(input.userHandle !== undefined ? { userHandle: input.userHandle } : {}),
    ...(input.anonymousClientKey !== undefined
      ? { anonymousClientKey: input.anonymousClientKey }
      : {}),
    ...(input.signCount !== undefined ? { signCount: input.signCount } : {}),
  });
  if (auth.verifyResponse.statusCode !== 200) {
    throw new Error(`mobile login failed with status ${String(auth.verifyResponse.statusCode)}`);
  }
  const body = auth.verifyResponse.json<{
    data: { sessionToken: string; sessionExpiresAt: string };
  }>();
  return {
    sessionToken: body.data.sessionToken,
    sessionExpiresAt: body.data.sessionExpiresAt,
  };
}

export async function reauthenticateMobile(input: {
  app: AppInstance;
  sessionToken: string;
  material: SoftPasskeyMaterial;
  signCount: number;
  userHandle?: Uint8Array;
}): Promise<{
  statusCode: number;
  body: Record<string, unknown>;
  sessionToken?: string;
}> {
  const optionsResponse = await input.app.inject({
    method: 'POST',
    url: '/v1/account/security/reauthentication/passkeys/options',
    headers: { authorization: `Session ${input.sessionToken}` },
    payload: {},
  });
  if (optionsResponse.statusCode !== 200) {
    return {
      statusCode: optionsResponse.statusCode,
      body: optionsResponse.json(),
    };
  }
  const options = optionsResponse.json<{
    data: {
      reauthenticationCeremonyId: string;
      options: { challenge: string };
    };
  }>();
  const verifyResponse = await input.app.inject({
    method: 'POST',
    url: '/v1/account/security/reauthentication/passkeys/verify',
    headers: { authorization: `Session ${input.sessionToken}` },
    payload: {
      reauthenticationCeremonyId: options.data.reauthenticationCeremonyId,
      response: input.material.createAuthenticationResponse({
        challenge: options.data.options.challenge,
        rpID: TEST_RP_ID,
        origin: TEST_ORIGIN,
        signCount: input.signCount,
        ...(input.userHandle !== undefined ? { userHandle: input.userHandle } : {}),
      }),
    },
  });
  const body = verifyResponse.json<{
    data: {
      status: string;
      freshUntil?: string;
      sessionToken?: string;
      sessionExpiresAt?: string;
    };
  }>();
  return {
    statusCode: verifyResponse.statusCode,
    body: body as unknown as Record<string, unknown>,
    ...(typeof body.data.sessionToken === 'string' ? { sessionToken: body.data.sessionToken } : {}),
  };
}

export async function addSecondPasskeyMobile(input: {
  app: AppInstance;
  sessionToken: string;
  existingMaterial: SoftPasskeyMaterial;
  userHandle?: Uint8Array;
}): Promise<{
  statusCode: number;
  passkey?: { id: string };
  sessionToken?: string;
  secondMaterial?: SoftPasskeyMaterial;
  body: Record<string, unknown>;
}> {
  const optionsResponse = await input.app.inject({
    method: 'POST',
    url: '/v1/account/passkeys/add/options',
    headers: { authorization: `Session ${input.sessionToken}` },
    payload: {},
  });
  if (optionsResponse.statusCode !== 200) {
    return {
      statusCode: optionsResponse.statusCode,
      body: optionsResponse.json(),
    };
  }
  const options = optionsResponse.json<{
    data: {
      registrationCeremonyId: string;
      options: { challenge: string; excludeCredentials?: { id: string }[] };
    };
  }>();
  const secondMaterial = createSoftPasskeyMaterial();
  const verifyResponse = await input.app.inject({
    method: 'POST',
    url: '/v1/account/passkeys/add/verify',
    headers: { authorization: `Session ${input.sessionToken}` },
    payload: {
      registrationCeremonyId: options.data.registrationCeremonyId,
      response: secondMaterial.createRegistrationResponse({
        challenge: options.data.options.challenge,
        rpID: TEST_RP_ID,
        origin: TEST_ORIGIN,
      }),
    },
  });
  const body = verifyResponse.json<{
    data: {
      status: string;
      passkey?: { id: string };
      sessionToken?: string;
    };
  }>();
  return {
    statusCode: verifyResponse.statusCode,
    body: body as unknown as Record<string, unknown>,
    ...(body.data.passkey && typeof body.data.passkey.id === 'string'
      ? { passkey: body.data.passkey }
      : {}),
    ...(typeof body.data.sessionToken === 'string' ? { sessionToken: body.data.sessionToken } : {}),
    secondMaterial,
  };
}

export async function listActivePasskeyPublicIds(
  app: AppInstance,
  accountId: string,
): Promise<string[]> {
  const rows = await app.database.db
    .select({ publicId: passkeyCredentials.publicId })
    .from(passkeyCredentials)
    .where(eq(passkeyCredentials.accountId, accountId));
  return rows.map((row) => row.publicId);
}

export async function countActivePasskeys(app: AppInstance, accountId: string): Promise<number> {
  const rows = await app.database.db
    .select()
    .from(passkeyCredentials)
    .where(eq(passkeyCredentials.accountId, accountId));
  return rows.filter((row) => row.revokedAt == null).length;
}

export async function ensureAccountActive(app: AppInstance, accountId: string): Promise<void> {
  const account = (
    await app.database.db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1)
  )[0];
  if (account?.status !== 'active') {
    throw new Error('expected active account');
  }
}

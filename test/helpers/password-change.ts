import Fastify from 'fastify';
import { Pool } from 'pg';
import { buildApp, type AppInstance } from '../../src/app.js';
import { createInMemoryTestDeliveryAdapter } from '../../src/ceremony/email-verification/delivery.js';
import {
  changeAccountPassword,
  PasswordChangeFailedError,
  RateLimitedError,
  SessionNotAuthorizedError,
  type PasswordChangeDeps,
  type PasswordChangeSuccess,
} from '../../src/ceremony/password-change/service.js';
import {
  PASSWORD_CHANGE_PUBLIC_ERROR_CODE,
  PASSWORD_CHANGE_PUBLIC_ERROR_MESSAGE,
} from '../../src/ceremony/password-change/policy.js';
import type { Env } from '../../src/config/env.js';
import { createDatabase } from '../../src/db/client.js';
import type { AccountSessionRow } from '../../src/db/schema.js';
import { AppError } from '../../src/errors/app-error.js';
import errorHandlerPlugin from '../../src/plugins/error-handler.js';
import {
  createPasskeyAuthenticationEnv,
  registerActivePasskeyAccount,
  TEST_CEREMONY_RATE_LIMIT_HASH_KEY,
  TEST_ORIGIN,
  TEST_SESSION_TOKEN_HASH_KEY,
  TEST_WEB_SESSION_COOKIE_NAME,
} from './passkey-authentication.js';
import { TEST_INITIAL_PASSWORD } from './passkey-registration.js';
import { requireDatabaseUrl, resetMigrateSeedFoundationAndActor } from './pg.js';
import { signInWithPassword } from './password-authentication.js';

export {
  TEST_CEREMONY_RATE_LIMIT_HASH_KEY,
  TEST_INITIAL_PASSWORD,
  TEST_ORIGIN,
  TEST_SESSION_TOKEN_HASH_KEY,
  TEST_WEB_SESSION_COOKIE_NAME,
  registerActivePasskeyAccount,
  signInWithPassword,
};

export const TEST_CHANGED_PASSWORD = 'changed-password-fifteen';
export const TEST_CHANGED_PASSWORD_B = 'changed-password-sixteen';

export function createPasswordChangeEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): Env {
  return createPasskeyAuthenticationEnv({
    PASSWORD_CHANGE_ENABLED: 'true',
    PASSWORD_SIGN_IN_ENABLED: 'true',
    ...overrides,
  });
}

export function createDeferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = () => {
      res();
    };
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function createCountdownBarrier(count: number): {
  arrive: () => Promise<void>;
  wait: () => Promise<void>;
} {
  let remaining = count;
  const gate = createDeferred();
  return {
    arrive: async () => {
      remaining -= 1;
      if (remaining === 0) {
        gate.resolve();
      }
      await gate.promise;
    },
    wait: () => gate.promise,
  };
}

/**
 * Poll until at least one backend session is waiting on a lock.
 * Yields via setImmediate (no arbitrary wall-clock sleep).
 */
export async function waitForPostgresLockWait(
  pool: Pool,
  options?: { timeoutMs?: number },
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? 10_000;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM pg_stat_activity
       WHERE datname = current_database()
         AND wait_event_type = 'Lock'
         AND state = 'active'
         AND pid <> pg_backend_pid()`,
    );
    if (Number(result.rows[0]?.count ?? 0) > 0) {
      return;
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
  throw new Error('timed out waiting for postgres lock wait');
}

export async function createPasswordChangeTestApp(options?: {
  passwordChangeEnabled?: boolean;
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

  const passwordChangeEnabled = options?.passwordChangeEnabled ?? true;
  const passwordSignInEnabled = options?.passwordSignInEnabled ?? true;
  const passkeyAuthenticationEnabled = options?.passkeyAuthenticationEnabled ?? true;
  const env = createPasswordChangeEnv({
    ...(passwordChangeEnabled ? {} : { PASSWORD_CHANGE_ENABLED: 'false' }),
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
    passwordChange: {
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

export async function changePasswordWithSession(input: {
  app: AppInstance;
  currentPassword?: string;
  newPassword?: string;
  sessionToken?: string;
  cookie?: string;
  origin?: string;
  secFetchSite?: string;
}) {
  const headers: Record<string, string> = {};
  if (input.sessionToken !== undefined) {
    headers.authorization = `Session ${input.sessionToken}`;
  }
  if (input.cookie !== undefined) {
    headers.cookie = input.cookie;
  }
  if (input.origin !== undefined) {
    headers.origin = input.origin;
  }
  if (input.secFetchSite !== undefined) {
    headers['sec-fetch-site'] = input.secFetchSite;
  }

  return input.app.inject({
    method: 'POST',
    url: '/v1/account/password/change',
    headers,
    payload: {
      currentPassword: input.currentPassword ?? TEST_INITIAL_PASSWORD,
      newPassword: input.newPassword ?? TEST_CHANGED_PASSWORD,
    },
  });
}

/**
 * Invoke changeAccountPassword through the production error-handler mapping used by
 * the password-change route, so injected dependency failures can assert HTTP 500
 * without altering the production route registration path.
 */
export async function invokePasswordChangeThroughErrorHandler(input: {
  db: AppInstance['database']['db'];
  deps: PasswordChangeDeps;
  session: AccountSessionRow;
  currentPassword: string;
  newPassword: string;
  requestId?: string;
}): Promise<{
  statusCode: number;
  body: { error?: { code: string; message: string }; data?: PasswordChangeSuccess };
}> {
  const app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);
  app.post('/v1/account/password/change', async () => {
    try {
      const result = await changeAccountPassword(input.db, input.deps, {
        session: input.session,
        currentPassword: input.currentPassword,
        newPassword: input.newPassword,
        requestId: input.requestId ?? null,
      });
      return { data: result };
    } catch (error) {
      if (error instanceof RateLimitedError) {
        throw new AppError(429, 'RATE_LIMITED', 'Rate limit exceeded.');
      }
      if (error instanceof SessionNotAuthorizedError) {
        throw new AppError(401, 'SESSION_NOT_AUTHORIZED', 'Session is not authorized.');
      }
      if (error instanceof PasswordChangeFailedError) {
        throw new AppError(
          400,
          PASSWORD_CHANGE_PUBLIC_ERROR_CODE,
          PASSWORD_CHANGE_PUBLIC_ERROR_MESSAGE,
        );
      }
      throw error;
    }
  });
  await app.ready();
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/account/password/change',
      payload: {},
    });
    return {
      statusCode: response.statusCode,
      body: response.json(),
    };
  } finally {
    await app.close();
  }
}

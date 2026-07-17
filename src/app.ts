import { type TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify from 'fastify';
import type { Env } from './config/env.js';
import { createDatabaseFromEnv, type Database } from './db/client.js';
import databasePlugin from './db/plugin.js';
import controlledAccessPlugin from './plugins/controlled-access.js';
import errorHandlerPlugin from './plugins/error-handler.js';
import openApiPlugin from './plugins/openapi.js';
import type { EmailVerificationDeliveryAdapter } from './ceremony/email-verification/delivery.js';
import { communitiesRoutes } from './routes/communities.js';
import { confirmationRoutes } from './routes/confirmations.js';
import { emailVerificationRoutes } from './routes/email-verifications.js';
import { healthRoutes } from './routes/health.js';
import { passkeyRegistrationRoutes } from './routes/passkey-registration.js';
import { signalsRoutes } from './routes/signals.js';

export type BuildAppOptions = {
  env: Env;
  logger?: boolean | Record<string, unknown>;
  /**
   * Optional injected database dependency for tests.
   * When omitted, a pool is created from validated environment settings.
   */
  database?: Database;
  emailVerification?: {
    deliveryAdapter?: EmailVerificationDeliveryAdapter;
    now?: () => string;
    generateCode?: () => string;
    generateSetupToken?: () => string;
    generateId?: () => string;
  };
  passkeyRegistration?: {
    now?: () => string;
    generateId?: () => string;
    generateUserHandle?: () => Buffer;
  };
};

const SENSITIVE_HEADER_REDACT = {
  paths: [
    'req.headers["x-town-control-key"]',
    'req.headers["X-TOWN-Control-Key"]',
    'req.headers.x-town-control-key',
    'req.headers.authorization',
    'req.headers.Authorization',
    'req.headers["authorization"]',
    'req.headers["Authorization"]',
  ],
  censor: '[Redacted]',
};

function resolveLoggerOption(
  env: Env,
  logger: BuildAppOptions['logger'],
): boolean | Record<string, unknown> {
  if (logger === false) {
    return false;
  }

  if (typeof logger === 'object') {
    return {
      level: env.LOG_LEVEL,
      ...logger,
      // Never serialize control keys or SetupGrant Authorization headers.
      redact: SENSITIVE_HEADER_REDACT,
    };
  }

  return {
    level: env.LOG_LEVEL,
    redact: SENSITIVE_HEADER_REDACT,
  };
}

export async function buildApp(options: BuildAppOptions) {
  const app = Fastify({
    logger: resolveLoggerOption(options.env, options.logger),
    requestIdHeader: 'x-request-id',
    trustProxy: options.env.TRUST_PROXY,
    genReqId: (req) => {
      const header = req.headers['x-request-id'];
      if (typeof header === 'string' && header.length > 0) {
        return header;
      }
      return `req_${crypto.randomUUID()}`;
    },
    // Honor TypeBox additionalProperties:false (do not silently strip extras).
    ajv: {
      customOptions: {
        removeAdditional: false,
      },
    },
  }).withTypeProvider<TypeBoxTypeProvider>();

  const database = options.database ?? createDatabaseFromEnv(options.env);

  await app.register(errorHandlerPlugin);
  await app.register(openApiPlugin);
  await app.register(controlledAccessPlugin, { env: options.env });
  await app.register(databasePlugin, { database });
  await app.register(healthRoutes);
  await app.register(communitiesRoutes);
  await app.register(signalsRoutes);
  await app.register(confirmationRoutes, { env: options.env });
  await app.register(emailVerificationRoutes, {
    env: options.env,
    ...(options.emailVerification?.deliveryAdapter !== undefined
      ? { deliveryAdapter: options.emailVerification.deliveryAdapter }
      : {}),
    ...(options.emailVerification?.now !== undefined ? { now: options.emailVerification.now } : {}),
    ...(options.emailVerification?.generateCode !== undefined
      ? { generateCode: options.emailVerification.generateCode }
      : {}),
    ...(options.emailVerification?.generateSetupToken !== undefined
      ? { generateSetupToken: options.emailVerification.generateSetupToken }
      : {}),
    ...(options.emailVerification?.generateId !== undefined
      ? { generateId: options.emailVerification.generateId }
      : {}),
  });
  await app.register(passkeyRegistrationRoutes, {
    env: options.env,
    ...(options.passkeyRegistration?.now !== undefined
      ? { now: options.passkeyRegistration.now }
      : {}),
    ...(options.passkeyRegistration?.generateId !== undefined
      ? { generateId: options.passkeyRegistration.generateId }
      : {}),
    ...(options.passkeyRegistration?.generateUserHandle !== undefined
      ? { generateUserHandle: options.passkeyRegistration.generateUserHandle }
      : {}),
  });

  return app;
}

export type AppInstance = Awaited<ReturnType<typeof buildApp>>;

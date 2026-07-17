import { type TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import type { Env } from './config/env.js';
import { createDatabaseFromEnv, type Database } from './db/client.js';
import databasePlugin from './db/plugin.js';
import controlledAccessPlugin from './plugins/controlled-access.js';
import errorHandlerPlugin from './plugins/error-handler.js';
import openApiPlugin from './plugins/openapi.js';
import type { EmailVerificationDeliveryAdapter } from './ceremony/email-verification/delivery.js';
import type { AccountRecoveryDeliveryAdapter } from './ceremony/account-recovery/delivery.js';
import { accountRecoveryRoutes } from './routes/account-recovery.js';
import { communitiesRoutes } from './routes/communities.js';
import { confirmationRoutes } from './routes/confirmations.js';
import { emailVerificationRoutes } from './routes/email-verifications.js';
import { healthRoutes } from './routes/health.js';
import { passkeyAuthenticationRoutes } from './routes/passkey-authentication.js';
import { membershipRoutes } from './routes/membership.js';
import { passkeyManagementRoutes } from './routes/passkey-management.js';
import { passkeyRegistrationRoutes } from './routes/passkey-registration.js';
import { signalsRoutes } from './routes/signals.js';
import { billingRoutes } from './routes/billing.js';
import type { LocalParticipationEligibilityResolver } from './membership/local-eligibility.js';
import type { TownStripeAdapter } from './billing/stripe-adapter.js';

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
  accountRecovery?: {
    deliveryAdapter?: AccountRecoveryDeliveryAdapter;
    now?: () => string;
    generateCode?: () => string;
    generateRecoveryToken?: () => string;
    generateId?: () => string;
  };
  passkeyRegistration?: {
    now?: () => string;
    generateId?: () => string;
    generateUserHandle?: () => Buffer;
  };
  passkeyAuthentication?: {
    now?: () => string;
    generateId?: () => string;
    generateToken?: () => string;
  };
  passkeyManagement?: {
    now?: () => string;
    generateId?: () => string;
    generateToken?: () => string;
  };
  membership?: {
    now?: () => string;
    generateId?: () => string;
    localEligibilityResolver?: LocalParticipationEligibilityResolver;
  };
  billing?: {
    now?: () => string;
    generateId?: () => string;
  };
  stripeAdapter?: TownStripeAdapter;
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
    'req.headers.cookie',
    'req.headers.Cookie',
    'req.headers["cookie"]',
    'req.headers["Cookie"]',
    'req.cookies.*',
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
  await app.register(cookie);
  await app.register(openApiPlugin);
  await app.register(controlledAccessPlugin, { env: options.env });
  await app.register(databasePlugin, { database });
  await app.register(healthRoutes);
  await app.register(communitiesRoutes);
  await app.register(signalsRoutes);
  await app.register(confirmationRoutes, {
    env: options.env,
    ...(options.membership?.now !== undefined ? { now: options.membership.now } : {}),
    ...(options.membership?.generateId !== undefined
      ? { generateId: options.membership.generateId }
      : {}),
    ...(options.membership?.localEligibilityResolver !== undefined
      ? { localEligibilityResolver: options.membership.localEligibilityResolver }
      : {}),
  });
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
  await app.register(accountRecoveryRoutes, {
    env: options.env,
    ...(options.accountRecovery?.deliveryAdapter !== undefined
      ? { deliveryAdapter: options.accountRecovery.deliveryAdapter }
      : {}),
    ...(options.accountRecovery?.now !== undefined ? { now: options.accountRecovery.now } : {}),
    ...(options.accountRecovery?.generateCode !== undefined
      ? { generateCode: options.accountRecovery.generateCode }
      : {}),
    ...(options.accountRecovery?.generateRecoveryToken !== undefined
      ? { generateRecoveryToken: options.accountRecovery.generateRecoveryToken }
      : {}),
    ...(options.accountRecovery?.generateId !== undefined
      ? { generateId: options.accountRecovery.generateId }
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
  await app.register(passkeyManagementRoutes, {
    env: options.env,
    ...(options.passkeyManagement?.now !== undefined
      ? { now: options.passkeyManagement.now }
      : options.passkeyAuthentication?.now !== undefined
        ? { now: options.passkeyAuthentication.now }
        : {}),
    ...(options.passkeyManagement?.generateId !== undefined
      ? { generateId: options.passkeyManagement.generateId }
      : options.passkeyAuthentication?.generateId !== undefined
        ? { generateId: options.passkeyAuthentication.generateId }
        : {}),
    ...(options.passkeyManagement?.generateToken !== undefined
      ? { generateToken: options.passkeyManagement.generateToken }
      : options.passkeyAuthentication?.generateToken !== undefined
        ? { generateToken: options.passkeyAuthentication.generateToken }
        : {}),
  });
  await app.register(passkeyAuthenticationRoutes, {
    env: options.env,
    ...(options.passkeyAuthentication?.now !== undefined
      ? { now: options.passkeyAuthentication.now }
      : {}),
    ...(options.passkeyAuthentication?.generateId !== undefined
      ? { generateId: options.passkeyAuthentication.generateId }
      : {}),
    ...(options.passkeyAuthentication?.generateToken !== undefined
      ? { generateToken: options.passkeyAuthentication.generateToken }
      : {}),
  });
  await app.register(membershipRoutes, {
    env: options.env,
    ...(options.membership?.now !== undefined ? { now: options.membership.now } : {}),
    ...(options.membership?.generateId !== undefined
      ? { generateId: options.membership.generateId }
      : {}),
    ...(options.membership?.localEligibilityResolver !== undefined
      ? { localEligibilityResolver: options.membership.localEligibilityResolver }
      : {}),
  });
  await app.register(billingRoutes, {
    env: options.env,
    ...(options.billing?.now !== undefined ? { now: options.billing.now } : {}),
    ...(options.billing?.generateId !== undefined
      ? { generateId: options.billing.generateId }
      : {}),
    ...(options.stripeAdapter !== undefined ? { stripeAdapter: options.stripeAdapter } : {}),
  });

  return app;
}

export type AppInstance = Awaited<ReturnType<typeof buildApp>>;

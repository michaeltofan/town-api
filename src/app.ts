import { type TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import type { Env } from './config/env.js';
import { createDatabaseFromEnv, type Database } from './db/client.js';
import databasePlugin from './db/plugin.js';
import { buildIdentityFromEnv } from './ops/build-identity.js';
import { resolveRequestId } from './ops/request-id.js';
import controlledAccessPlugin from './plugins/controlled-access.js';
import corsPlugin from './plugins/cors.js';
import errorHandlerPlugin from './plugins/error-handler.js';
import openApiPlugin from './plugins/openapi.js';
import type { EmailVerificationDeliveryAdapter } from './ceremony/email-verification/delivery.js';
import type { AccountRecoveryDeliveryAdapter } from './ceremony/account-recovery/delivery.js';
import { accountRecoveryRoutes } from './routes/account-recovery.js';
import { communitiesRoutes } from './routes/communities.js';
import { confirmationRoutes } from './routes/confirmations.js';
import { discussionSessionRoutes } from './routes/discussion-session.js';
import { emailVerificationRoutes } from './routes/email-verifications.js';
import { healthRoutes } from './routes/health.js';
import { passkeyAuthenticationRoutes } from './routes/passkey-authentication.js';
import { membershipRoutes } from './routes/membership.js';
import { passkeyManagementRoutes } from './routes/passkey-management.js';
import { passkeyRegistrationRoutes } from './routes/passkey-registration.js';
import { passwordSetupRoutes } from './routes/password-setup.js';
import { passwordAuthenticationRoutes } from './routes/password-authentication.js';
import { passwordChangeRoutes } from './routes/password-change.js';
import { signalsRoutes } from './routes/signals.js';
import { signalModerationRoutes } from './routes/signal-moderation.js';
import { accountModerationRoutes } from './routes/account-moderation.js';
import { billingRoutes } from './routes/billing.js';
import { googlePlayRoutes } from './routes/google-play.js';
import { googlePlayRtdnRoutes } from './routes/google-play-rtdn.js';
import { localEligibilityRoutes } from './routes/local-eligibility.js';
import { communityCommitmentRoutes } from './routes/community-commitment.js';
import { signalSubmissionRoutes } from './routes/signal-submissions.js';
import type { LocalParticipationEligibilityResolver } from './membership/local-eligibility.js';
import type { TownStripeAdapter } from './billing/stripe-adapter.js';
import type { TownGooglePlayAndroidPublisherAdapter } from './membership/google-play/android-publisher-adapter.js';
import type { PubSubPushVerifier } from './membership/google-play/rtdn/verify-pubsub-push.js';
import type { GooglePlayRtdnInboxPersister } from './membership/google-play/rtdn/inbox.js';
import { createObjectStorageAdapterFromEnv } from './storage/create-object-storage-from-env.js';
import type { TownObjectStorageAdapter } from './storage/object-storage-adapter.js';

export type BuildAppOptions = {
  env: Env;
  logger?: boolean | Record<string, unknown>;
  /**
   * Optional injected database dependency for tests.
   * When omitted, a pool is created from validated environment settings.
   */
  database?: Database;
  /**
   * Optional private object-storage adapter (discussion contribution media).
   * When omitted, created from env when OBJECT_STORAGE_ENABLED is true.
   */
  objectStorageAdapter?: TownObjectStorageAdapter | null;
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
  passwordSetup?: {
    now?: () => string;
    generateId?: () => string;
    generateSetupToken?: () => string;
  };
  passwordAuthentication?: {
    now?: () => string;
    generateId?: () => string;
    generateToken?: () => string;
  };
  passwordChange?: {
    now?: () => string;
    generateId?: () => string;
    generateToken?: () => string;
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
  googlePlay?: {
    now?: () => string;
    generateId?: () => string;
  };
  googlePlayRtdn?: {
    verifier?: PubSubPushVerifier;
    persistInbox?: GooglePlayRtdnInboxPersister;
  };
  stripeAdapter?: TownStripeAdapter;
  googlePlayAdapter?: TownGooglePlayAndroidPublisherAdapter;
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
    'req.headers["stripe-signature"]',
    'req.headers["Stripe-Signature"]',
    'req.headers.stripe-signature',
    'req.cookies.*',
    'req.body.password',
    'req.body.currentPassword',
    'req.body.newPassword',
    'req.body.token',
    'req.body.recoveryToken',
    'req.body.setupToken',
    'req.body.purchaseToken',
    'DATABASE_URL',
    'env.DATABASE_URL',
    '*.DATABASE_URL',
    '*.STRIPE_SECRET_KEY',
    '*.STRIPE_WEBHOOK_SECRET',
    '*.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON',
    '*.SESSION_TOKEN_HASH_KEY',
    '*.EMAIL_VERIFICATION_HASH_KEY',
    '*.EMAIL_VERIFICATION_RESEND_API_KEY',
    '*.OBJECT_STORAGE_ACCESS_KEY_ID',
    '*.OBJECT_STORAGE_SECRET_ACCESS_KEY',
    '*.CEREMONY_RATE_LIMIT_HASH_KEY',
    '*.WEBAUTHN_CHALLENGE_HASH_KEY',
    '*.PASSKEY_AUTHENTICATION_CHALLENGE_HASH_KEY',
    '*.ACCOUNT_RECOVERY_HASH_KEY',
    '*.ACCOUNT_RECOVERY_TOKEN_HASH_KEY',
    '*.PASSWORD_HASH_PEPPER',
    '*.CONTROLLED_CONFIRMATION_KEY',
    '*.OWNER_SETUP_CODE',
    '*.OWNER_SETUP_CODE_EXPECTED',
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

  const identity = buildIdentityFromEnv(env);
  const base: Record<string, unknown> = {
    service: identity.service,
    environment: identity.environment,
    version: identity.version,
    commitSha: identity.commitSha,
  };

  if (typeof logger === 'object') {
    return {
      level: env.LOG_LEVEL,
      base,
      ...logger,
      // Never serialize control keys, SetupGrant Authorization headers, or secrets.
      redact: SENSITIVE_HEADER_REDACT,
    };
  }

  return {
    level: env.LOG_LEVEL,
    base,
    redact: SENSITIVE_HEADER_REDACT,
  };
}

export async function buildApp(options: BuildAppOptions) {
  const app = Fastify({
    logger: resolveLoggerOption(options.env, options.logger),
    // Deployment Readiness V1: validate incoming x-request-id ourselves so
    // that malformed client-supplied ids are always replaced with a fresh
    // req_<uuid>. Setting requestIdHeader to false forces genReqId to run for
    // every request regardless of what the client sent.
    requestIdHeader: false,
    trustProxy: options.env.TRUST_PROXY,
    genReqId: (req) => resolveRequestId(req.headers['x-request-id']),
    // Honor TypeBox additionalProperties:false (do not silently strip extras).
    ajv: {
      customOptions: {
        removeAdditional: false,
      },
    },
  }).withTypeProvider<TypeBoxTypeProvider>();

  // Deployment Readiness V1: mark shutdown state on the instance so /health/ready
  // can fail fast without exposing shutdown signals or timers to callers.
  if (!app.hasDecorator('isShuttingDown')) {
    app.decorate('isShuttingDown', false);
  }

  // Always echo the accepted/generated request id to the client for correlation.
  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  const database = options.database ?? createDatabaseFromEnv(options.env);

  await app.register(errorHandlerPlugin);
  await app.register(corsPlugin, { env: options.env });
  await app.register(cookie);
  await app.register(openApiPlugin);
  await app.register(controlledAccessPlugin, { env: options.env });
  await app.register(databasePlugin, { database });
  await app.register(healthRoutes, { env: options.env });
  await app.register(communitiesRoutes);
  await app.register(signalsRoutes);
  await app.register(signalModerationRoutes, {
    env: options.env,
    ...(options.membership?.now !== undefined ? { now: options.membership.now } : {}),
    ...(options.membership?.generateId !== undefined
      ? { generateId: options.membership.generateId }
      : {}),
  });
  await app.register(accountModerationRoutes, {
    env: options.env,
    ...(options.membership?.now !== undefined ? { now: options.membership.now } : {}),
    ...(options.membership?.generateId !== undefined
      ? { generateId: options.membership.generateId }
      : {}),
  });
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
  const objectStorageAdapter =
    options.objectStorageAdapter !== undefined
      ? options.objectStorageAdapter
      : createObjectStorageAdapterFromEnv(options.env);

  await app.register(discussionSessionRoutes, {
    env: options.env,
    ...(options.membership?.now !== undefined ? { now: options.membership.now } : {}),
    ...(options.membership?.generateId !== undefined
      ? { generateId: options.membership.generateId }
      : {}),
    ...(options.membership?.localEligibilityResolver !== undefined
      ? { localEligibilityResolver: options.membership.localEligibilityResolver }
      : {}),
    objectStorageAdapter,
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
  await app.register(passwordSetupRoutes, {
    env: options.env,
    ...(options.passwordSetup?.now !== undefined ? { now: options.passwordSetup.now } : {}),
    ...(options.passwordSetup?.generateId !== undefined
      ? { generateId: options.passwordSetup.generateId }
      : {}),
    ...(options.passwordSetup?.generateSetupToken !== undefined
      ? { generateSetupToken: options.passwordSetup.generateSetupToken }
      : {}),
  });
  await app.register(passwordAuthenticationRoutes, {
    env: options.env,
    ...(options.passwordAuthentication?.now !== undefined
      ? { now: options.passwordAuthentication.now }
      : {}),
    ...(options.passwordAuthentication?.generateId !== undefined
      ? { generateId: options.passwordAuthentication.generateId }
      : {}),
    ...(options.passwordAuthentication?.generateToken !== undefined
      ? { generateToken: options.passwordAuthentication.generateToken }
      : {}),
  });
  await app.register(passwordChangeRoutes, {
    env: options.env,
    ...(options.passwordChange?.now !== undefined ? { now: options.passwordChange.now } : {}),
    ...(options.passwordChange?.generateId !== undefined
      ? { generateId: options.passwordChange.generateId }
      : {}),
    ...(options.passwordChange?.generateToken !== undefined
      ? { generateToken: options.passwordChange.generateToken }
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
  await app.register(communityCommitmentRoutes, {
    env: options.env,
    ...(options.membership?.now !== undefined ? { now: options.membership.now } : {}),
  });
  await app.register(localEligibilityRoutes, {
    env: options.env,
    ...(options.membership?.now !== undefined ? { now: options.membership.now } : {}),
  });
  await app.register(signalSubmissionRoutes, {
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
  await app.register(googlePlayRoutes, {
    env: options.env,
    ...(options.googlePlay?.now !== undefined ? { now: options.googlePlay.now } : {}),
    ...(options.googlePlay?.generateId !== undefined
      ? { generateId: options.googlePlay.generateId }
      : {}),
    ...(options.googlePlayAdapter !== undefined
      ? { googlePlayAdapter: options.googlePlayAdapter }
      : {}),
  });
  await app.register(googlePlayRtdnRoutes, {
    env: options.env,
    ...(options.googlePlayRtdn?.verifier !== undefined
      ? { verifier: options.googlePlayRtdn.verifier }
      : {}),
    ...(options.googlePlayRtdn?.persistInbox !== undefined
      ? { persistInbox: options.googlePlayRtdn.persistInbox }
      : {}),
  });

  return app;
}

export type AppInstance = Awaited<ReturnType<typeof buildApp>>;

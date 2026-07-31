import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import type { Env } from '../config/env.js';
import { parseRecoveryGrantAuthorization } from '../ceremony/account-recovery/authorization.js';
import {
  createDevelopmentRecoveryDeliveryAdapter,
  createInMemoryTestRecoveryDeliveryAdapter,
  type AccountRecoveryDeliveryAdapter,
} from '../ceremony/account-recovery/delivery.js';
import { createRecoveryResendDeliveryAdapter } from '../ceremony/account-recovery/resend-delivery.js';
import {
  AccountRecoveryPasskeyOptionsBodySchema,
  AccountRecoveryPasskeyVerifyBodySchema,
  AccountRecoveryRequestBodySchema,
  AccountRecoveryRouteResponses,
  AccountRecoveryVerifyEmailBodySchema,
} from '../ceremony/account-recovery/schemas.js';
import {
  createRecoveryPasskeyRegistrationOptions,
  InvalidOrExpiredChallengeError,
  RecoveryNotAuthorizedError,
  requestAccountRecovery,
  verifyRecoveryEmail,
  verifyRecoveryPasskeyRegistration,
  type AccountRecoveryDeps,
} from '../ceremony/account-recovery/service.js';
import { AppError } from '../errors/app-error.js';
import { toIsoTimestamp } from '../lib/timestamps.js';

export type AccountRecoveryRoutesOptions = {
  env: Env;
  deliveryAdapter?: AccountRecoveryDeliveryAdapter;
  now?: () => string;
  generateCode?: () => string;
  generateRecoveryToken?: () => string;
  generateId?: () => string;
};

function createDeliveryAdapter(
  env: Env,
  log: { warn: (obj: object, msg?: string) => void },
): AccountRecoveryDeliveryAdapter {
  if (env.ACCOUNT_RECOVERY_DELIVERY_MODE === 'development') {
    return createDevelopmentRecoveryDeliveryAdapter();
  }
  if (env.ACCOUNT_RECOVERY_DELIVERY_MODE === 'resend') {
    const apiKey = env.EMAIL_VERIFICATION_RESEND_API_KEY;
    const from = env.EMAIL_VERIFICATION_FROM_ADDRESS;
    if (!apiKey || !from) {
      throw new Error('Resend recovery delivery requires API key and from address');
    }
    return createRecoveryResendDeliveryAdapter({
      apiKey,
      from,
      ...(env.EMAIL_VERIFICATION_REPLY_TO !== undefined
        ? { replyTo: env.EMAIL_VERIFICATION_REPLY_TO }
        : {}),
      log: (event) => {
        log.warn(event, 'recovery email delivery failed');
      },
    });
  }
  return createInMemoryTestRecoveryDeliveryAdapter();
}

function assertAccountRecoveryEnabled(env: Env, reply: { callNotFound: () => unknown }): boolean {
  if (!env.ACCOUNT_RECOVERY_ENABLED) {
    void reply.callNotFound();
    return false;
  }
  return true;
}

function invalidOrExpiredChallengeError(): AppError {
  return new AppError(
    400,
    'INVALID_OR_EXPIRED_CHALLENGE',
    'The verification challenge is invalid or has expired.',
  );
}

function recoveryNotAuthorizedError(): AppError {
  return new AppError(400, 'RECOVERY_NOT_AUTHORIZED', 'Account recovery could not be completed.');
}

export const accountRecoveryRoutes: FastifyPluginCallbackTypebox<AccountRecoveryRoutesOptions> = (
  app,
  options,
  done,
) => {
  const { env } = options;
  const delivery = options.deliveryAdapter ?? createDeliveryAdapter(env, app.log);

  const buildDeps = (): AccountRecoveryDeps => ({
    env,
    delivery,
    now: options.now ?? (() => new Date().toISOString()),
    ...(options.generateCode !== undefined ? { generateCode: options.generateCode } : {}),
    ...(options.generateRecoveryToken !== undefined
      ? { generateRecoveryToken: options.generateRecoveryToken }
      : {}),
    ...(options.generateId !== undefined ? { generateId: options.generateId } : {}),
  });

  app.post(
    '/v1/account/recovery',
    {
      schema: {
        tags: ['Account'],
        summary: 'Request account recovery',
        description:
          'Requests account recovery for an active account with a verified primary email. Always returns a generic accepted response with a recoveryVerificationId and never discloses account existence or eligibility. Does not create a session. Disabled by default via ACCOUNT_RECOVERY_ENABLED.',
        body: AccountRecoveryRequestBodySchema,
        response: AccountRecoveryRouteResponses.request,
      },
    },
    async (request, reply) => {
      if (!assertAccountRecoveryEnabled(env, reply)) {
        return;
      }

      const result = await requestAccountRecovery(app.database.db, buildDeps(), {
        email: request.body.email,
        ...(request.body.locale !== undefined ? { locale: request.body.locale } : {}),
        ip: request.ip,
        requestId: request.id,
      });

      return reply.status(202).send({
        data: {
          status: result.status,
          recoveryVerificationId: result.recoveryVerificationId,
        },
      });
    },
  );

  app.post(
    '/v1/account/recovery/verify-email',
    {
      schema: {
        tags: ['Account'],
        summary: 'Verify account recovery email challenge',
        description:
          'Completes recovery email verification with a six-digit code. On success returns a one-time restricted recovery grant. Failures return a generic invalid/expired challenge error. Does not create a session.',
        body: AccountRecoveryVerifyEmailBodySchema,
        response: AccountRecoveryRouteResponses.verifyEmail,
      },
    },
    async (request, reply) => {
      if (!assertAccountRecoveryEnabled(env, reply)) {
        return;
      }

      try {
        const result = await verifyRecoveryEmail(app.database.db, buildDeps(), {
          recoveryVerificationId: request.body.recoveryVerificationId,
          code: request.body.code,
          ip: request.ip,
          requestId: request.id,
        });
        return await reply.status(200).send({
          data: {
            status: result.status,
            recoveryGrant: result.recoveryGrant,
            recoveryGrantExpiresAt: toIsoTimestamp(result.recoveryGrantExpiresAt),
          },
        });
      } catch (error) {
        if (error instanceof InvalidOrExpiredChallengeError) {
          throw invalidOrExpiredChallengeError();
        }
        throw invalidOrExpiredChallengeError();
      }
    },
  );

  app.post(
    '/v1/account/recovery/passkeys/registration/options',
    {
      schema: {
        tags: ['Account'],
        summary: 'Create recovery WebAuthn passkey registration options',
        description:
          'Issues PublicKeyCredentialCreationOptions for recovery passkey registration. Requires Authorization: RecoveryGrant <token>. Reuses the existing WebAuthn user handle and excludes active passkeys. Does not create a session.',
        security: [{ recoveryGrantAuth: [] }],
        body: AccountRecoveryPasskeyOptionsBodySchema,
        response: AccountRecoveryRouteResponses.options,
      },
    },
    async (request, reply) => {
      if (!assertAccountRecoveryEnabled(env, reply)) {
        return;
      }

      const auth = parseRecoveryGrantAuthorization(request.headers.authorization);
      if (!auth.ok) {
        throw recoveryNotAuthorizedError();
      }

      try {
        const result = await createRecoveryPasskeyRegistrationOptions(
          app.database.db,
          buildDeps(),
          {
            recoveryToken: auth.token,
            requestId: request.id,
          },
        );
        return await reply.status(200).send({
          data: {
            recoveryCeremonyId: result.recoveryCeremonyId,
            options: result.options,
          },
        });
      } catch (error) {
        if (error instanceof RecoveryNotAuthorizedError) {
          request.log.info(
            {
              requestId: request.id,
              route: 'account_recovery_passkey_options',
              outcome: 'failed',
              failureCategory: error.failureCategory,
            },
            'Account recovery passkey options failed',
          );
        }
        throw recoveryNotAuthorizedError();
      }
    },
  );

  app.post(
    '/v1/account/recovery/passkeys/registration/verify',
    {
      schema: {
        tags: ['Account'],
        summary: 'Verify recovery WebAuthn passkey registration',
        description:
          'Verifies a recovery WebAuthn registration response, adds a passkey while keeping existing passkeys active, consumes the recovery grant, revokes all sessions, and marks recovery completed. Requires Authorization: RecoveryGrant <token>. Does not create a session.',
        security: [{ recoveryGrantAuth: [] }],
        body: AccountRecoveryPasskeyVerifyBodySchema,
        response: AccountRecoveryRouteResponses.verify,
      },
    },
    async (request, reply) => {
      if (!assertAccountRecoveryEnabled(env, reply)) {
        return;
      }

      const auth = parseRecoveryGrantAuthorization(request.headers.authorization);
      if (!auth.ok) {
        throw recoveryNotAuthorizedError();
      }

      try {
        const result = await verifyRecoveryPasskeyRegistration(app.database.db, buildDeps(), {
          recoveryToken: auth.token,
          recoveryCeremonyId: request.body.recoveryCeremonyId,
          response: request.body.response as RegistrationResponseJSON,
          requestId: request.id,
        });
        return await reply.status(200).send({
          data: {
            status: result.status,
          },
        });
      } catch (error) {
        if (error instanceof RecoveryNotAuthorizedError) {
          request.log.info(
            {
              requestId: request.id,
              route: 'account_recovery_passkey_verify',
              outcome: 'failed',
              failureCategory: error.failureCategory,
            },
            'Account recovery passkey verify failed',
          );
        }
        throw recoveryNotAuthorizedError();
      }
    },
  );

  done();
};

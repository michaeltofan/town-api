import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import type { Env } from '../config/env.js';
import {
  createDevelopmentDeliveryAdapter,
  createInMemoryTestDeliveryAdapter,
  type EmailVerificationDeliveryAdapter,
} from '../ceremony/email-verification/delivery.js';
import { createResendDeliveryAdapter } from '../ceremony/email-verification/resend-delivery.js';
import {
  EmailVerificationCompleteBodySchema,
  EmailVerificationRequestBodySchema,
  EmailVerificationRouteResponses,
} from '../ceremony/email-verification/schemas.js';
import {
  completeEmailVerification,
  requestEmailVerification,
  type EmailVerificationDeps,
} from '../ceremony/email-verification/service.js';
import { AppError } from '../errors/app-error.js';
import { toIsoTimestamp } from '../lib/timestamps.js';

export type EmailVerificationRoutesOptions = {
  env: Env;
  deliveryAdapter?: EmailVerificationDeliveryAdapter;
  now?: () => string;
  generateCode?: () => string;
  generateSetupToken?: () => string;
  generateId?: () => string;
};

function createDeliveryAdapter(
  env: Env,
  log: { warn: (obj: object, msg?: string) => void },
): EmailVerificationDeliveryAdapter {
  if (env.EMAIL_VERIFICATION_DELIVERY_MODE === 'development') {
    return createDevelopmentDeliveryAdapter();
  }
  if (env.EMAIL_VERIFICATION_DELIVERY_MODE === 'resend') {
    const apiKey = env.EMAIL_VERIFICATION_RESEND_API_KEY;
    const from = env.EMAIL_VERIFICATION_FROM_ADDRESS;
    if (!apiKey || !from) {
      throw new Error('Resend delivery requires API key and from address');
    }
    return createResendDeliveryAdapter({
      apiKey,
      from,
      ...(env.EMAIL_VERIFICATION_REPLY_TO !== undefined
        ? { replyTo: env.EMAIL_VERIFICATION_REPLY_TO }
        : {}),
      log: (event) => {
        log.warn(event, 'email delivery failed');
      },
    });
  }
  return createInMemoryTestDeliveryAdapter();
}

function assertEmailVerificationEnabled(env: Env, reply: { callNotFound: () => unknown }): boolean {
  if (!env.EMAIL_VERIFICATION_ENABLED) {
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

export const emailVerificationRoutes: FastifyPluginCallbackTypebox<
  EmailVerificationRoutesOptions
> = (app, options, done) => {
  const { env } = options;
  const delivery = options.deliveryAdapter ?? createDeliveryAdapter(env, app.log);

  const buildDeps = (): EmailVerificationDeps => ({
    env,
    delivery,
    now: options.now ?? (() => new Date().toISOString()),
    ...(options.generateCode !== undefined ? { generateCode: options.generateCode } : {}),
    ...(options.generateSetupToken !== undefined
      ? { generateSetupToken: options.generateSetupToken }
      : {}),
    ...(options.generateId !== undefined ? { generateId: options.generateId } : {}),
  });

  app.post(
    '/v1/account/email-verifications',
    {
      schema: {
        tags: ['Account'],
        summary: 'Request account email verification',
        description:
          'Requests email verification for account setup. Always returns a generic accepted response with a verificationId and never discloses account existence. Does not create a session or activate an account. Disabled by default via EMAIL_VERIFICATION_ENABLED.',
        body: EmailVerificationRequestBodySchema,
        response: EmailVerificationRouteResponses.request,
      },
    },
    async (request, reply) => {
      if (!assertEmailVerificationEnabled(env, reply)) {
        return;
      }

      const result = await requestEmailVerification(app.database.db, buildDeps(), {
        email: request.body.email,
        ...(request.body.locale !== undefined ? { locale: request.body.locale } : {}),
        ip: request.ip,
        requestId: request.id,
      });

      return reply.status(202).send({
        data: {
          status: result.status,
          verificationId: result.verificationId,
        },
      });
    },
  );

  app.post(
    '/v1/account/email-verifications/complete',
    {
      schema: {
        tags: ['Account'],
        summary: 'Complete account email verification',
        description:
          'Completes email verification with a six-digit code. On success transitions pending_email to pending_passkey and returns a one-time restricted setup grant. Failures return a generic invalid/expired challenge error. Does not create a session or activate the account.',
        body: EmailVerificationCompleteBodySchema,
        response: EmailVerificationRouteResponses.complete,
      },
    },
    async (request, reply) => {
      if (!assertEmailVerificationEnabled(env, reply)) {
        return;
      }

      try {
        const result = await completeEmailVerification(app.database.db, buildDeps(), {
          verificationId: request.body.verificationId,
          code: request.body.code,
          ip: request.ip,
          requestId: request.id,
        });
        return await reply.status(200).send({
          data: {
            status: result.status,
            setupGrant: result.setupGrant,
            setupGrantExpiresAt: toIsoTimestamp(result.setupGrantExpiresAt),
          },
        });
      } catch {
        throw invalidOrExpiredChallengeError();
      }
    },
  );

  done();
};

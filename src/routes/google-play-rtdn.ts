import { Type } from '@sinclair/typebox';
import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { AppError } from '../errors/app-error.js';
import {
  parseRtdnNotification,
  RtdnParseError,
} from '../membership/google-play/rtdn/parse-notification.js';
import {
  createPubSubPushVerifier,
  PubSubPushAuthenticationError,
  PubSubPushVerifierUnavailableError,
  type PubSubPushVerifier,
} from '../membership/google-play/rtdn/verify-pubsub-push.js';
import { DomainErrorResponseSchema } from '../schemas/error.js';
import type { Env } from '../config/env.js';

export type GooglePlayRtdnRoutesOptions = {
  env: Env;
  verifier?: PubSubPushVerifier;
};

function extractSingleBearerToken(rawHeaders: readonly string[]): string {
  const values: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === 'authorization') {
      values.push(rawHeaders[index + 1] ?? '');
    }
  }
  if (values.length !== 1) {
    throw new PubSubPushAuthenticationError();
  }
  const match = /^Bearer ([^\s]+)$/.exec(values[0] ?? '');
  if (!match?.[1]) {
    throw new PubSubPushAuthenticationError();
  }
  return match[1];
}

export const googlePlayRtdnRoutes: FastifyPluginCallbackTypebox<GooglePlayRtdnRoutesOptions> = (
  app,
  options,
  done,
) => {
  const { env } = options;

  // Keep the body opaque until the handler has authenticated the push.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, next) => {
    next(null, body);
  });

  app.post(
    '/v1/billing/google-play/rtdn',
    {
      bodyLimit: 1_048_576,
      schema: {
        tags: ['Billing'],
        summary: 'Authenticate and validate a Google Play RTDN push',
        description:
          'Authenticates a Google Pub/Sub OIDC push and validates its Google Play RTDN payload. Test notifications are acknowledged. Real notifications return 503 until a durable inbox exists; this route never reads or mutates membership state.',
        response: {
          204: Type.Null(),
          400: DomainErrorResponseSchema,
          401: DomainErrorResponseSchema,
          503: DomainErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!env.GOOGLE_PLAY_RTDN_INGRESS_ENABLED) {
        reply.callNotFound();
        return;
      }

      const audience = env.GOOGLE_PLAY_RTDN_OIDC_AUDIENCE;
      const serviceAccountEmail = env.GOOGLE_PLAY_RTDN_PUSH_SERVICE_ACCOUNT_EMAIL;
      const subscription = env.GOOGLE_PLAY_RTDN_PUBSUB_SUBSCRIPTION;
      const packageName = env.GOOGLE_PLAY_PACKAGE_NAME;
      if (!audience || !serviceAccountEmail || !subscription || !packageName) {
        throw new AppError(
          503,
          'GOOGLE_PLAY_RTDN_UNAVAILABLE',
          'Google Play RTDN ingress is unavailable.',
        );
      }

      let token: string;
      try {
        token = extractSingleBearerToken(request.raw.rawHeaders);
        const verifier =
          options.verifier ??
          createPubSubPushVerifier({
            audience,
            serviceAccountEmail,
          });
        await verifier(token);
      } catch (error) {
        if (error instanceof PubSubPushVerifierUnavailableError) {
          throw new AppError(
            503,
            'GOOGLE_PLAY_RTDN_UNAVAILABLE',
            'Google Play RTDN ingress is unavailable.',
          );
        }
        throw new AppError(
          401,
          'PUBSUB_PUSH_NOT_AUTHORIZED',
          'Pub/Sub push is not authorized.',
        );
      }

      const rawBody = request.body;
      if (!Buffer.isBuffer(rawBody)) {
        throw new AppError(400, 'INVALID_GOOGLE_PLAY_RTDN', 'Invalid Google Play RTDN payload.');
      }

      let notification;
      try {
        notification = parseRtdnNotification(rawBody, {
          packageName,
          subscription,
        });
      } catch (error) {
        if (error instanceof RtdnParseError) {
          throw new AppError(
            400,
            'INVALID_GOOGLE_PLAY_RTDN',
            'Invalid Google Play RTDN payload.',
          );
        }
        throw error;
      }

      if (notification.kind === 'test') {
        request.log.info(
          {
            event: 'google_play_rtdn_test_received',
            messageId: notification.messageId,
            eventTimeMillis: notification.eventTimeMillis,
          },
          'Google Play RTDN test notification received',
        );
        return reply.status(204).send();
      }

      request.log.info(
        {
          event: 'google_play_rtdn_real_received_without_durable_sink',
          messageId: notification.messageId,
          eventTimeMillis: notification.eventTimeMillis,
          notificationKind: notification.kind,
          notificationType: notification.notificationType,
        },
        'Google Play RTDN real notification requires retry',
      );

      // Future durable-insert point: an inbox slice (migration 0016) must persist
      // this trigger before returning 2xx. Durable storage is intentionally out of scope here.
      throw new AppError(
        503,
        'GOOGLE_PLAY_RTDN_RETRY_REQUIRED',
        'Google Play RTDN processing is not available.',
      );
    },
  );

  done();
};

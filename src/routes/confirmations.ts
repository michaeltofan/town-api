import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import type { Env } from '../config/env.js';
import {
  ensureSignalConfirmation,
  getActorConfirmationState,
} from '../db/repositories/confirmations.js';
import { toIsoTimestamp } from '../lib/timestamps.js';
import { assertControlledAccess } from '../plugins/controlled-access.js';
import { ConfirmationPutBodySchema, ConfirmationResponseSchema } from '../schemas/confirmations.js';
import { DomainErrorResponseSchema, SignalIdParamsSchema } from '../schemas/signals.js';
import { ErrorResponseSchema } from '../schemas/error.js';

export type ConfirmationRoutesOptions = {
  env: Env;
};

function requireConfiguredActorId(env: Env): string {
  const actorId = env.CONTROLLED_TEST_ACTOR_ID;
  if (actorId === undefined) {
    throw new Error('Controlled confirmation setup is invalid');
  }
  return actorId;
}

export const confirmationRoutes: FastifyPluginCallbackTypebox<ConfirmationRoutesOptions> = (
  app,
  options,
  done,
) => {
  const { env } = options;

  app.get(
    '/v1/signals/:signalId/confirmation',
    {
      schema: {
        tags: ['Confirmations'],
        summary: 'Get controlled confirmation state for a published signal',
        description:
          'Temporary controlled test mechanism using X-TOWN-Control-Key. This is not public authentication. Returns actor-specific confirmation state for the configured controlled test actor. No public counts or actor identifiers are exposed.',
        security: [{ TownControlKey: [] }],
        params: SignalIdParamsSchema,
        response: {
          200: ConfirmationResponseSchema,
          400: ErrorResponseSchema,
          401: DomainErrorResponseSchema,
          403: DomainErrorResponseSchema,
          404: DomainErrorResponseSchema,
        },
      },
      preHandler: async (request, reply) => {
        assertControlledAccess(request, reply, env);
        if (reply.sent) {
          return reply;
        }
      },
    },
    async (request, reply) => {
      if (reply.sent) {
        return;
      }

      const actorId = requireConfiguredActorId(env);
      const state = await getActorConfirmationState(
        app.database.db,
        actorId,
        request.params.signalId,
      );

      return {
        data: {
          signalId: state.signalId,
          confirmed: state.confirmed,
          confirmedAt: state.confirmedAt === null ? null : toIsoTimestamp(state.confirmedAt),
        },
      };
    },
  );

  app.put(
    '/v1/signals/:signalId/confirmation',
    {
      schema: {
        tags: ['Confirmations'],
        summary: 'Confirm a published signal for the controlled test actor',
        description:
          'Temporary controlled test mechanism using X-TOWN-Control-Key. This is not public authentication. Idempotent PUT: first request creates the confirmation; repeats return the same confirmedAt. Body must be empty. No public counts or actor identifiers are exposed.',
        security: [{ TownControlKey: [] }],
        params: SignalIdParamsSchema,
        body: ConfirmationPutBodySchema,
        response: {
          200: ConfirmationResponseSchema,
          400: ErrorResponseSchema,
          401: DomainErrorResponseSchema,
          403: DomainErrorResponseSchema,
          404: DomainErrorResponseSchema,
        },
      },
      preHandler: async (request, reply) => {
        assertControlledAccess(request, reply, env);
        if (reply.sent) {
          return reply;
        }
      },
    },
    async (request, reply) => {
      if (reply.sent) {
        return;
      }

      const actorId = requireConfiguredActorId(env);
      const result = await ensureSignalConfirmation(
        app.database.db,
        actorId,
        request.params.signalId,
      );

      return {
        data: {
          signalId: result.signalId,
          confirmed: true,
          confirmedAt: toIsoTimestamp(result.confirmation.confirmedAt),
        },
      };
    },
  );

  done();
};

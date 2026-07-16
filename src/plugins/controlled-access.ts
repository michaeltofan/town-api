import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { Env } from '../config/env.js';
import { controlledAccessRequiredError } from '../errors/app-error.js';
import { safeEqualString } from '../lib/safe-equal.js';

export const CONTROLLED_ACCESS_HEADER = 'x-town-control-key';

export type ControlledAccessOptions = {
  env: Env;
};

/**
 * Temporary controlled-test access gate.
 * This is not public authentication, sessions, or identity verification.
 *
 * When disabled, uses the existing Fastify not-found handler so the response
 * shape matches unknown routes and does not reveal the mechanism.
 */
export function assertControlledAccess(
  request: FastifyRequest,
  reply: FastifyReply,
  env: Env,
): void {
  if (!env.CONTROLLED_CONFIRMATION_ENABLED) {
    reply.callNotFound();
    return;
  }

  const configuredKey = env.CONTROLLED_CONFIRMATION_KEY;
  if (configuredKey === undefined) {
    reply.callNotFound();
    return;
  }

  const supplied = request.headers[CONTROLLED_ACCESS_HEADER];
  const suppliedKey = Array.isArray(supplied) ? supplied[0] : supplied;

  if (typeof suppliedKey !== 'string' || suppliedKey.length === 0) {
    throw controlledAccessRequiredError();
  }

  if (!safeEqualString(suppliedKey, configuredKey)) {
    throw controlledAccessRequiredError();
  }
}

const controlledAccessPlugin: FastifyPluginCallback<ControlledAccessOptions> = (
  app,
  options,
  done,
) => {
  app.decorate('townEnv', options.env);
  done();
};

export default fp(controlledAccessPlugin, {
  name: 'controlled-access',
});

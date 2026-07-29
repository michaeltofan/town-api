import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import type { Env } from '../config/env.js';
import { parseSetupGrantAuthorization } from '../ceremony/password-setup/authorization.js';
import {
  PASSWORD_SETUP_PUBLIC_ERROR_CODE,
  PASSWORD_SETUP_PUBLIC_ERROR_MESSAGE,
} from '../ceremony/password-setup/policy.js';
import {
  PasswordSetupBodySchema,
  PasswordSetupRouteResponses,
} from '../ceremony/password-setup/schemas.js';
import {
  completeInitialPasswordSetup,
  PasswordSetupFailedError,
  type PasswordSetupDeps,
} from '../ceremony/password-setup/service.js';
import { AppError } from '../errors/app-error.js';
import { toIsoTimestamp } from '../lib/timestamps.js';

export type PasswordSetupRoutesOptions = {
  env: Env;
  now?: () => string;
  generateId?: () => string;
  generateSetupToken?: () => string;
};

function assertPasswordAuthEnabled(env: Env, reply: { callNotFound: () => unknown }): boolean {
  if (!env.PASSWORD_AUTH_ENABLED) {
    void reply.callNotFound();
    return false;
  }
  return true;
}

function passwordSetupFailedError(): AppError {
  return new AppError(400, PASSWORD_SETUP_PUBLIC_ERROR_CODE, PASSWORD_SETUP_PUBLIC_ERROR_MESSAGE);
}

export const passwordSetupRoutes: FastifyPluginCallbackTypebox<PasswordSetupRoutesOptions> = (
  app,
  options,
  done,
) => {
  const { env } = options;

  const buildDeps = (): PasswordSetupDeps => ({
    env,
    now: options.now ?? (() => new Date().toISOString()),
    ...(options.generateId !== undefined ? { generateId: options.generateId } : {}),
    ...(options.generateSetupToken !== undefined
      ? { generateSetupToken: options.generateSetupToken }
      : {}),
  });

  app.post(
    '/v1/account/password',
    {
      schema: {
        tags: ['Account'],
        summary: 'Complete initial password setup',
        description:
          'Sets the initial password for a pending_password account authorized by Authorization: SetupGrant <token> with purpose initial_password_setup. On success stores the Argon2id credential, transitions the account to pending_passkey, consumes the password-setup grant, and returns a fresh initial_passkey_registration setup grant. Disabled by default via PASSWORD_AUTH_ENABLED. Does not create a session or activate the account. Failures return PASSWORD_SETUP_FAILED.',
        security: [{ setupGrantAuth: [] }],
        body: PasswordSetupBodySchema,
        response: PasswordSetupRouteResponses,
      },
    },
    async (request, reply) => {
      if (!assertPasswordAuthEnabled(env, reply)) {
        return;
      }

      const auth = parseSetupGrantAuthorization(request.headers.authorization);
      if (!auth.ok) {
        throw passwordSetupFailedError();
      }

      try {
        const result = await completeInitialPasswordSetup(app.database.db, buildDeps(), {
          setupToken: auth.token,
          password: request.body.password,
          requestId: request.id,
        });
        return await reply.status(200).send({
          data: {
            status: result.status,
            setupGrant: result.setupGrant,
            setupGrantExpiresAt: toIsoTimestamp(result.setupGrantExpiresAt),
          },
        });
      } catch (error) {
        if (error instanceof PasswordSetupFailedError) {
          request.log.info(
            {
              requestId: request.id,
              route: 'password_setup',
              outcome: 'failed',
              failureCategory: error.failureCategory,
            },
            'Password setup failed',
          );
        }
        throw passwordSetupFailedError();
      }
    },
  );

  done();
};

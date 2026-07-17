import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import type { Env } from '../config/env.js';
import { parseSetupGrantAuthorization } from '../ceremony/passkey-registration/authorization.js';
import {
  PasskeyRegistrationOptionsBodySchema,
  PasskeyRegistrationRouteResponses,
  PasskeyRegistrationVerifyBodySchema,
} from '../ceremony/passkey-registration/schemas.js';
import {
  createPasskeyRegistrationOptions,
  PasskeyRegistrationFailedError,
  verifyPasskeyRegistration,
  type PasskeyRegistrationDeps,
} from '../ceremony/passkey-registration/service.js';
import { AppError } from '../errors/app-error.js';

export type PasskeyRegistrationRoutesOptions = {
  env: Env;
  now?: () => string;
  generateId?: () => string;
  generateUserHandle?: () => Buffer;
};

function assertWebAuthnRegistrationEnabled(
  env: Env,
  reply: { callNotFound: () => unknown },
): boolean {
  if (!env.WEBAUTHN_REGISTRATION_ENABLED) {
    void reply.callNotFound();
    return false;
  }
  return true;
}

function passkeyRegistrationFailedError(): AppError {
  return new AppError(
    400,
    'PASSKEY_REGISTRATION_FAILED',
    'Passkey registration could not be completed.',
  );
}

export const passkeyRegistrationRoutes: FastifyPluginCallbackTypebox<
  PasskeyRegistrationRoutesOptions
> = (app, options, done) => {
  const { env } = options;

  const buildDeps = (): PasskeyRegistrationDeps => ({
    env,
    now: options.now ?? (() => new Date().toISOString()),
    ...(options.generateId !== undefined ? { generateId: options.generateId } : {}),
    ...(options.generateUserHandle !== undefined
      ? { generateUserHandle: options.generateUserHandle }
      : {}),
  });

  app.post(
    '/v1/account/passkeys/registration/options',
    {
      schema: {
        tags: ['Account'],
        summary: 'Create WebAuthn passkey registration options',
        description:
          'Issues PublicKeyCredentialCreationOptions for first-passkey registration. Requires Authorization: SetupGrant <token>. Account is derived exclusively from the setup grant. Disabled by default via WEBAUTHN_REGISTRATION_ENABLED. Does not create a session.',
        security: [{ setupGrantAuth: [] }],
        body: PasskeyRegistrationOptionsBodySchema,
        response: PasskeyRegistrationRouteResponses.options,
      },
    },
    async (request, reply) => {
      if (!assertWebAuthnRegistrationEnabled(env, reply)) {
        return;
      }

      const auth = parseSetupGrantAuthorization(request.headers.authorization);
      if (!auth.ok) {
        throw passkeyRegistrationFailedError();
      }

      try {
        const result = await createPasskeyRegistrationOptions(app.database.db, buildDeps(), {
          setupToken: auth.token,
          requestId: request.id,
        });
        return await reply.status(200).send({
          data: {
            registrationCeremonyId: result.registrationCeremonyId,
            options: result.options,
          },
        });
      } catch (error) {
        if (error instanceof PasskeyRegistrationFailedError) {
          request.log.info(
            {
              requestId: request.id,
              route: 'passkey_registration_options',
              outcome: 'failed',
              failureCategory: error.failureCategory,
            },
            'Passkey registration options failed',
          );
        }
        throw passkeyRegistrationFailedError();
      }
    },
  );

  app.post(
    '/v1/account/passkeys/registration/verify',
    {
      schema: {
        tags: ['Account'],
        summary: 'Verify WebAuthn passkey registration',
        description:
          'Verifies a WebAuthn registration response, persists the passkey, creates an unassigned civic actor, activates the account, and consumes the setup grant. Requires Authorization: SetupGrant <token>. Failures return PASSKEY_REGISTRATION_FAILED. Does not create a session.',
        security: [{ setupGrantAuth: [] }],
        body: PasskeyRegistrationVerifyBodySchema,
        response: PasskeyRegistrationRouteResponses.verify,
      },
    },
    async (request, reply) => {
      if (!assertWebAuthnRegistrationEnabled(env, reply)) {
        return;
      }

      const auth = parseSetupGrantAuthorization(request.headers.authorization);
      if (!auth.ok) {
        throw passkeyRegistrationFailedError();
      }

      try {
        const result = await verifyPasskeyRegistration(app.database.db, buildDeps(), {
          setupToken: auth.token,
          registrationCeremonyId: request.body.registrationCeremonyId,
          response: request.body.response as RegistrationResponseJSON,
          requestId: request.id,
        });
        return await reply.status(200).send({
          data: {
            status: result.status,
          },
        });
      } catch (error) {
        if (error instanceof PasskeyRegistrationFailedError) {
          request.log.info(
            {
              requestId: request.id,
              route: 'passkey_registration_verify',
              outcome: 'failed',
              failureCategory: error.failureCategory,
            },
            'Passkey registration verify failed',
          );
        }
        throw passkeyRegistrationFailedError();
      }
    },
  );

  done();
};

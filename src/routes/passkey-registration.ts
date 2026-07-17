import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import type { Env } from '../config/env.js';
import { parseSetupGrantAuthorization } from '../ceremony/passkey-registration/authorization.js';
import {
  PasskeyRegistrationOptionsBodySchema,
  PasskeyRegistrationVerifyBodySchema,
} from '../ceremony/passkey-registration/schemas.js';
import { PasskeyManagementRouteResponses } from '../ceremony/passkey-management/schemas.js';
import {
  createPasskeyRegistrationOptions,
  PasskeyRegistrationFailedError,
  verifyPasskeyRegistration,
  type PasskeyRegistrationDeps,
} from '../ceremony/passkey-registration/service.js';
import {
  createManagedPasskeyRegistrationOptions,
  FreshAuthenticationRequiredError,
  PasskeyRegistrationFailedError as ManagePasskeyRegistrationFailedError,
  RateLimitedError,
  SessionNotAuthorizedError,
  verifyManagedPasskeyRegistration,
  type PasskeyManagementDeps,
} from '../ceremony/passkey-management/service.js';
import { requirePasskeyManagementConfig } from '../ceremony/passkey-management/config.js';
import { assertWebCookieCsrf } from '../ceremony/passkey-authentication/csrf.js';
import {
  parseSessionAuthorizationHeader,
  parseWebSessionCookie,
} from '../ceremony/passkey-authentication/session-transport.js';
import { resolveActiveSession } from '../ceremony/passkey-authentication/service.js';
import { AppError } from '../errors/app-error.js';

export type PasskeyRegistrationRoutesOptions = {
  env: Env;
  now?: () => string;
  generateId?: () => string;
  generateUserHandle?: () => Buffer;
  generateToken?: () => string;
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

function sessionNotAuthorizedError(): AppError {
  return new AppError(401, 'SESSION_NOT_AUTHORIZED', 'Session is not authorized.');
}

function freshAuthenticationRequiredError(): AppError {
  return new AppError(403, 'FRESH_AUTHENTICATION_REQUIRED', 'Fresh authentication is required.');
}

function rateLimitedError(): AppError {
  return new AppError(429, 'RATE_LIMITED', 'Rate limit exceeded.');
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function sessionCookieMaxAgeSeconds(input: { now: string; absoluteExpiresAt: string }): number {
  return Math.max(
    0,
    Math.floor(
      (new Date(input.absoluteExpiresAt).getTime() - new Date(input.now).getTime()) / 1000,
    ),
  );
}

function webSessionCookieOptions(input: { now: string; absoluteExpiresAt: string }) {
  return {
    secure: true,
    httpOnly: true,
    path: '/',
    sameSite: 'lax' as const,
    maxAge: sessionCookieMaxAgeSeconds(input),
  };
}

function extractSessionTransport(input: {
  authorization: string | string[] | undefined;
  cookieName: string;
  cookies: Record<string, string | undefined> | undefined;
}) {
  const web = parseWebSessionCookie({
    cookieName: input.cookieName,
    cookies: input.cookies,
  });
  if (web.ok) {
    return web;
  }
  return parseSessionAuthorizationHeader(input.authorization);
}

function isRejectedGrantScheme(authorization: string | string[] | undefined): boolean {
  const raw = Array.isArray(authorization) ? authorization[0] : authorization;
  if (raw === undefined || raw.length === 0) {
    return false;
  }
  const space = raw.indexOf(' ');
  if (space <= 0) {
    return false;
  }
  const scheme = raw.slice(0, space);
  return scheme === 'RecoveryGrant' || scheme === 'Bearer';
}

export const passkeyRegistrationRoutes: FastifyPluginCallbackTypebox<
  PasskeyRegistrationRoutesOptions
> = (app, options, done) => {
  const { env } = options;
  const now = () => (options.now ?? (() => new Date().toISOString()))();

  const buildRegistrationDeps = (): PasskeyRegistrationDeps => ({
    env,
    now,
    ...(options.generateId !== undefined ? { generateId: options.generateId } : {}),
    ...(options.generateUserHandle !== undefined
      ? { generateUserHandle: options.generateUserHandle }
      : {}),
  });

  const buildManagementDeps = (): PasskeyManagementDeps => ({
    env,
    now,
    ...(options.generateId !== undefined ? { generateId: options.generateId } : {}),
    ...(options.generateToken !== undefined ? { generateToken: options.generateToken } : {}),
  });

  const buildAuthDeps = () => ({
    env,
    now,
    ...(options.generateId !== undefined ? { generateId: options.generateId } : {}),
    ...(options.generateToken !== undefined ? { generateToken: options.generateToken } : {}),
  });

  async function tryResolveSession(request: {
    headers: {
      authorization?: string | string[] | undefined;
      origin?: string | string[] | undefined;
      'sec-fetch-site'?: string | string[] | undefined;
    };
    cookies?: Record<string, string | undefined>;
    requireCsrf: boolean;
  }) {
    if (!env.PASSKEY_AUTHENTICATION_ENABLED) {
      return null;
    }
    if (isRejectedGrantScheme(request.headers.authorization)) {
      throw sessionNotAuthorizedError();
    }
    let config;
    try {
      config = requirePasskeyManagementConfig(env);
    } catch {
      return null;
    }
    const extracted = extractSessionTransport({
      authorization: request.headers.authorization,
      cookieName: config.webSessionCookieName,
      cookies: request.cookies,
    });
    if (!extracted.ok) {
      return null;
    }
    if (extracted.clientType === 'web' && request.requireCsrf) {
      const csrf = assertWebCookieCsrf({
        originHeader: singleHeader(request.headers.origin),
        secFetchSite: singleHeader(request.headers['sec-fetch-site']),
        allowedOrigins: config.allowedOrigins,
      });
      if (!csrf.ok) {
        throw sessionNotAuthorizedError();
      }
    }
    const session = await resolveActiveSession(app.database.db, buildAuthDeps(), {
      clientType: extracted.clientType,
      token: extracted.token,
    });
    if (!session) {
      throw sessionNotAuthorizedError();
    }
    return { session, clientType: extracted.clientType };
  }

  app.post(
    '/v1/account/passkeys/registration/options',
    {
      schema: {
        tags: ['Account'],
        summary: 'Create WebAuthn passkey registration options',
        description:
          'Dual-mode registration options. With an active Session (cookie or Authorization: Session), issues manage_passkeys_register options requiring freshness. Otherwise requires Authorization: SetupGrant for first-passkey registration. RecoveryGrant and Bearer are rejected. Disabled by default via WEBAUTHN_REGISTRATION_ENABLED for SetupGrant mode; session mode also requires PASSKEY_AUTHENTICATION_ENABLED.',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }, { setupGrantAuth: [] }],
        body: PasskeyRegistrationOptionsBodySchema,
        response: PasskeyManagementRouteResponses.dualRegistrationOptions,
      },
    },
    async (request, reply) => {
      if (!assertWebAuthnRegistrationEnabled(env, reply)) {
        return;
      }

      try {
        const sessionAuth = await tryResolveSession({
          headers: request.headers,
          cookies: request.cookies,
          requireCsrf: true,
        });
        if (sessionAuth) {
          const result = await createManagedPasskeyRegistrationOptions(
            app.database.db,
            buildManagementDeps(),
            {
              session: sessionAuth.session,
              requestId: request.id,
            },
          );
          return await reply.status(200).send({
            data: {
              registrationCeremonyId: result.registrationCeremonyId,
              options: result.options,
            },
          });
        }

        const auth = parseSetupGrantAuthorization(request.headers.authorization);
        if (!auth.ok) {
          throw passkeyRegistrationFailedError();
        }

        const result = await createPasskeyRegistrationOptions(
          app.database.db,
          buildRegistrationDeps(),
          {
            setupToken: auth.token,
            requestId: request.id,
          },
        );
        return await reply.status(200).send({
          data: {
            registrationCeremonyId: result.registrationCeremonyId,
            options: result.options,
          },
        });
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }
        if (error instanceof RateLimitedError) {
          throw rateLimitedError();
        }
        if (error instanceof FreshAuthenticationRequiredError) {
          throw freshAuthenticationRequiredError();
        }
        if (error instanceof SessionNotAuthorizedError) {
          throw sessionNotAuthorizedError();
        }
        if (
          error instanceof PasskeyRegistrationFailedError ||
          error instanceof ManagePasskeyRegistrationFailedError
        ) {
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
          'Dual-mode registration verify. With an active Session, completes manage_passkeys_register (requires freshness), rotates the session, and revokes other sessions with passkey_added. Otherwise requires SetupGrant for first-passkey activation (ACCOUNT_READY). RecoveryGrant and Bearer are rejected.',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }, { setupGrantAuth: [] }],
        body: PasskeyRegistrationVerifyBodySchema,
        response: PasskeyManagementRouteResponses.dualRegistrationVerify,
      },
    },
    async (request, reply) => {
      if (!assertWebAuthnRegistrationEnabled(env, reply)) {
        return;
      }

      try {
        const sessionAuth = await tryResolveSession({
          headers: request.headers,
          cookies: request.cookies,
          requireCsrf: true,
        });
        if (sessionAuth) {
          const result = await verifyManagedPasskeyRegistration(
            app.database.db,
            buildManagementDeps(),
            {
              session: sessionAuth.session,
              registrationCeremonyId: request.body.registrationCeremonyId,
              response: request.body.response as RegistrationResponseJSON,
              ...('label' in request.body
                ? { label: (request.body as { label?: string | null }).label ?? null }
                : {}),
              requestId: request.id,
            },
          );
          if (result.rotation.clientType === 'web') {
            const config = requirePasskeyManagementConfig(env);
            reply.setCookie(
              config.webSessionCookieName,
              result.rotation.rawToken,
              webSessionCookieOptions({
                now: now(),
                absoluteExpiresAt: result.rotation.session.absoluteExpiresAt,
              }),
            );
            return await reply.status(200).send({
              data: {
                status: result.status,
                passkey: result.passkey,
              },
            });
          }
          return await reply.status(200).send({
            data: {
              status: result.status,
              passkey: result.passkey,
              sessionToken: result.rotation.rawToken,
              sessionExpiresAt: result.rotation.session.absoluteExpiresAt,
            },
          });
        }

        const auth = parseSetupGrantAuthorization(request.headers.authorization);
        if (!auth.ok) {
          throw passkeyRegistrationFailedError();
        }

        const result = await verifyPasskeyRegistration(app.database.db, buildRegistrationDeps(), {
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
        if (error instanceof AppError) {
          throw error;
        }
        if (error instanceof RateLimitedError) {
          throw rateLimitedError();
        }
        if (error instanceof FreshAuthenticationRequiredError) {
          throw freshAuthenticationRequiredError();
        }
        if (error instanceof SessionNotAuthorizedError) {
          throw sessionNotAuthorizedError();
        }
        if (
          error instanceof PasskeyRegistrationFailedError ||
          error instanceof ManagePasskeyRegistrationFailedError
        ) {
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

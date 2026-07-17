import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import type { Env } from '../config/env.js';
import { requirePasskeyAuthenticationConfig } from '../ceremony/passkey-authentication/config.js';
import { assertWebCookieCsrf } from '../ceremony/passkey-authentication/csrf.js';
import {
  PasskeyAuthenticationOptionsBodySchema,
  PasskeyAuthenticationRouteResponses,
  PasskeyAuthenticationVerifyBodySchema,
} from '../ceremony/passkey-authentication/schemas.js';
import {
  parseSessionAuthorizationHeader,
  parseWebSessionCookie,
  type SessionTransportExtraction,
} from '../ceremony/passkey-authentication/session-transport.js';
import {
  AuthenticationFailedError,
  createPasskeyAuthenticationOptions,
  logoutAllSessions,
  logoutCurrentSession,
  RecentAuthenticationRequiredError,
  resolveActiveSession,
  rotateCurrentSession,
  sessionIntrospection,
  verifyPasskeyAuthentication,
  type PasskeyAuthenticationDeps,
} from '../ceremony/passkey-authentication/service.js';
import { AppError } from '../errors/app-error.js';

export type PasskeyAuthenticationRoutesOptions = {
  env: Env;
  now?: () => string;
  generateId?: () => string;
  generateToken?: () => string;
};

function assertPasskeyAuthenticationEnabled(
  env: Env,
  reply: { callNotFound: () => unknown },
): boolean {
  if (!env.PASSKEY_AUTHENTICATION_ENABLED) {
    void reply.callNotFound();
    return false;
  }
  return true;
}

function authenticationFailedError(statusCode: 400 | 401 = 400): AppError {
  return new AppError(
    statusCode,
    'AUTHENTICATION_FAILED',
    'Authentication could not be completed.',
  );
}

function recentAuthenticationRequiredError(): AppError {
  return new AppError(401, 'RECENT_AUTHENTICATION_REQUIRED', 'Recent authentication is required.');
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

function webSessionClearCookieOptions() {
  return {
    secure: true,
    httpOnly: true,
    path: '/',
    sameSite: 'lax' as const,
  };
}

function extractSessionTransport(input: {
  authorization: string | string[] | undefined;
  cookieName: string;
  cookies: Record<string, string | undefined> | undefined;
}): SessionTransportExtraction {
  const web = parseWebSessionCookie({
    cookieName: input.cookieName,
    cookies: input.cookies,
  });
  if (web.ok) {
    return web;
  }

  return parseSessionAuthorizationHeader(input.authorization);
}

function assertWebCsrf(input: {
  originHeader: string | undefined;
  secFetchSite: string | undefined;
  allowedOrigins: readonly string[];
}): void {
  const csrf = assertWebCookieCsrf(input);
  if (!csrf.ok) {
    throw authenticationFailedError();
  }
}

export const passkeyAuthenticationRoutes: FastifyPluginCallbackTypebox<
  PasskeyAuthenticationRoutesOptions
> = (app, options, done) => {
  const { env } = options;

  const now = () => (options.now ?? (() => new Date().toISOString()))();

  const buildDeps = (): PasskeyAuthenticationDeps => ({
    env,
    now,
    ...(options.generateId !== undefined ? { generateId: options.generateId } : {}),
    ...(options.generateToken !== undefined ? { generateToken: options.generateToken } : {}),
  });

  app.post(
    '/v1/authentication/passkeys/options',
    {
      schema: {
        tags: ['Authentication'],
        summary: 'Create WebAuthn passkey authentication options',
        description:
          'Issues PublicKeyCredentialRequestOptions for passkey authentication. Does not disclose account existence through allowCredentials; user verification is required. Disabled by default via PASSKEY_AUTHENTICATION_ENABLED.',
        body: PasskeyAuthenticationOptionsBodySchema,
        response: PasskeyAuthenticationRouteResponses.options,
      },
    },
    async (request, reply) => {
      if (!assertPasskeyAuthenticationEnabled(env, reply)) {
        return;
      }

      try {
        const result = await createPasskeyAuthenticationOptions(app.database.db, buildDeps(), {
          clientType: request.body.clientType,
          anonymousClientKey: request.body.anonymousClientKey,
          ip: request.ip,
          requestId: request.id,
        });
        return await reply.status(200).send({
          data: {
            authenticationCeremonyId: result.authenticationCeremonyId,
            options: result.options,
          },
        });
      } catch (error) {
        if (error instanceof AuthenticationFailedError) {
          request.log.info(
            {
              requestId: request.id,
              route: 'passkey_authentication_options',
              outcome: 'failed',
              failureCategory: error.failureCategory,
            },
            'Passkey authentication options failed',
          );
        }
        throw authenticationFailedError();
      }
    },
  );

  app.post(
    '/v1/authentication/passkeys/verify',
    {
      schema: {
        tags: ['Authentication'],
        summary: 'Verify WebAuthn passkey authentication',
        description:
          'Verifies a WebAuthn authentication assertion and creates a web or mobile session. Web sessions are returned only as a Secure HttpOnly __Host cookie. Mobile sessions are returned only in the JSON body for use as Authorization: Session <token>.',
        body: PasskeyAuthenticationVerifyBodySchema,
        response: PasskeyAuthenticationRouteResponses.verify,
      },
    },
    async (request, reply) => {
      if (!assertPasskeyAuthenticationEnabled(env, reply)) {
        return;
      }

      try {
        const result = await verifyPasskeyAuthentication(app.database.db, buildDeps(), {
          authenticationCeremonyId: request.body.authenticationCeremonyId,
          clientType: request.body.clientType,
          response: request.body.response as AuthenticationResponseJSON,
          ip: request.ip,
          requestId: request.id,
        });

        if (result.clientType === 'web') {
          const config = requirePasskeyAuthenticationConfig(env);
          reply.setCookie(
            config.webSessionCookieName,
            result.rawToken,
            webSessionCookieOptions({
              now: now(),
              absoluteExpiresAt: result.session.absoluteExpiresAt,
            }),
          );
          return await reply.status(200).send({
            data: {
              status: result.status,
            },
          });
        }

        return await reply.status(200).send({
          data: {
            status: result.status,
            sessionToken: result.rawToken,
            sessionExpiresAt: result.sessionExpiresAt,
          },
        });
      } catch (error) {
        if (error instanceof AuthenticationFailedError) {
          request.log.info(
            {
              requestId: request.id,
              route: 'passkey_authentication_verify',
              outcome: 'failed',
              failureCategory: error.failureCategory,
            },
            'Passkey authentication verify failed',
          );
        }
        throw authenticationFailedError();
      }
    },
  );

  app.get(
    '/v1/authentication/session',
    {
      schema: {
        tags: ['Authentication'],
        summary: 'Inspect the current authentication session',
        description:
          'Returns current session state. Web clients authenticate only with the configured session cookie; mobile clients authenticate only with Authorization: Session <token>. Invalid or missing sessions return authenticated:false.',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        response: PasskeyAuthenticationRouteResponses.session,
      },
    },
    async (request, reply) => {
      if (!assertPasskeyAuthenticationEnabled(env, reply)) {
        return;
      }

      const config = requirePasskeyAuthenticationConfig(env);
      const extracted = extractSessionTransport({
        authorization: request.headers.authorization,
        cookieName: config.webSessionCookieName,
        cookies: request.cookies,
      });
      const session = extracted.ok
        ? await resolveActiveSession(app.database.db, buildDeps(), {
            clientType: extracted.clientType,
            token: extracted.token,
          })
        : null;

      const introspection = sessionIntrospection(session, now());
      if (introspection.authenticated) {
        return await reply.status(200).send({
          data: introspection,
        });
      }
      return await reply.status(200).send({
        data: introspection,
      });
    },
  );

  app.post(
    '/v1/authentication/session/rotate',
    {
      schema: {
        tags: ['Authentication'],
        summary: 'Rotate the current authentication session',
        description:
          'Replaces the current session token without refreshing authentication freshness. Web cookie sessions require same-origin/same-site CSRF evidence and receive a replacement Secure HttpOnly cookie. Mobile sessions use Authorization: Session <token> and receive the replacement token in JSON.',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        response: PasskeyAuthenticationRouteResponses.rotate,
      },
    },
    async (request, reply) => {
      if (!assertPasskeyAuthenticationEnabled(env, reply)) {
        return;
      }

      const config = requirePasskeyAuthenticationConfig(env);
      const extracted = extractSessionTransport({
        authorization: request.headers.authorization,
        cookieName: config.webSessionCookieName,
        cookies: request.cookies,
      });
      if (!extracted.ok) {
        throw authenticationFailedError(401);
      }
      if (extracted.clientType === 'web') {
        assertWebCsrf({
          originHeader: singleHeader(request.headers.origin),
          secFetchSite: singleHeader(request.headers['sec-fetch-site']),
          allowedOrigins: config.allowedOrigins,
        });
      }

      try {
        const result = await rotateCurrentSession(app.database.db, buildDeps(), {
          clientType: extracted.clientType,
          token: extracted.token,
          requestId: request.id,
        });

        if (result.clientType === 'web') {
          reply.setCookie(
            config.webSessionCookieName,
            result.rawToken,
            webSessionCookieOptions({
              now: now(),
              absoluteExpiresAt: result.session.absoluteExpiresAt,
            }),
          );
          return await reply.status(200).send({
            data: {
              status: result.status,
            },
          });
        }

        return await reply.status(200).send({
          data: {
            status: result.status,
            sessionToken: result.rawToken,
            sessionExpiresAt: result.sessionExpiresAt,
          },
        });
      } catch (error) {
        if (error instanceof AuthenticationFailedError) {
          throw authenticationFailedError(401);
        }
        throw error;
      }
    },
  );

  app.post(
    '/v1/authentication/logout',
    {
      schema: {
        tags: ['Authentication'],
        summary: 'Logout the current authentication session',
        description:
          'Revokes the current session when present. Web cookie sessions require same-origin/same-site CSRF evidence and the response clears the configured session cookie. The operation is idempotent.',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        response: PasskeyAuthenticationRouteResponses.logout,
      },
    },
    async (request, reply) => {
      if (!assertPasskeyAuthenticationEnabled(env, reply)) {
        return;
      }

      const config = requirePasskeyAuthenticationConfig(env);
      const extracted = extractSessionTransport({
        authorization: request.headers.authorization,
        cookieName: config.webSessionCookieName,
        cookies: request.cookies,
      });
      if (extracted.ok && extracted.clientType === 'web') {
        assertWebCsrf({
          originHeader: singleHeader(request.headers.origin),
          secFetchSite: singleHeader(request.headers['sec-fetch-site']),
          allowedOrigins: config.allowedOrigins,
        });
      }

      if (extracted.ok) {
        await logoutCurrentSession(app.database.db, buildDeps(), {
          clientType: extracted.clientType,
          token: extracted.token,
          requestId: request.id,
        });
      }

      if (!extracted.ok || extracted.clientType === 'web') {
        reply.clearCookie(config.webSessionCookieName, webSessionClearCookieOptions());
      }

      return await reply.status(200).send({
        data: {
          status: 'SIGNED_OUT',
        },
      });
    },
  );

  app.post(
    '/v1/authentication/logout-all',
    {
      schema: {
        tags: ['Authentication'],
        summary: 'Logout all authentication sessions',
        description:
          'Revokes all active sessions for the authenticated account. Requires a fresh authentication session. Web cookie sessions require same-origin/same-site CSRF evidence and the response clears the configured session cookie.',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        response: PasskeyAuthenticationRouteResponses.logoutAll,
      },
    },
    async (request, reply) => {
      if (!assertPasskeyAuthenticationEnabled(env, reply)) {
        return;
      }

      const config = requirePasskeyAuthenticationConfig(env);
      const extracted = extractSessionTransport({
        authorization: request.headers.authorization,
        cookieName: config.webSessionCookieName,
        cookies: request.cookies,
      });
      if (!extracted.ok) {
        throw authenticationFailedError(401);
      }
      if (extracted.clientType === 'web') {
        assertWebCsrf({
          originHeader: singleHeader(request.headers.origin),
          secFetchSite: singleHeader(request.headers['sec-fetch-site']),
          allowedOrigins: config.allowedOrigins,
        });
      }

      try {
        const result = await logoutAllSessions(app.database.db, buildDeps(), {
          clientType: extracted.clientType,
          token: extracted.token,
          requestId: request.id,
        });
        if (extracted.clientType === 'web') {
          reply.clearCookie(config.webSessionCookieName, webSessionClearCookieOptions());
        }
        return await reply.status(200).send({
          data: result,
        });
      } catch (error) {
        if (error instanceof RecentAuthenticationRequiredError) {
          throw recentAuthenticationRequiredError();
        }
        if (error instanceof AuthenticationFailedError) {
          throw authenticationFailedError(401);
        }
        throw error;
      }
    },
  );

  done();
};

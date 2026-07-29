import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import type { Env } from '../config/env.js';
import { requirePasswordChangeConfig } from '../ceremony/password-change/config.js';
import { assertWebCookieCsrf } from '../ceremony/passkey-authentication/csrf.js';
import {
  PasswordChangeBodySchema,
  PasswordChangeRouteResponses,
} from '../ceremony/password-change/schemas.js';
import {
  changeAccountPassword,
  PasswordChangeFailedError,
  RateLimitedError,
  SessionNotAuthorizedError,
  type PasswordChangeDeps,
} from '../ceremony/password-change/service.js';
import {
  parseSessionAuthorizationHeader,
  parseWebSessionCookie,
  type SessionTransportExtraction,
} from '../ceremony/passkey-authentication/session-transport.js';
import { findAccountById } from '../identity/repositories/accounts.js';
import { findActiveAccountSessionByTokenHash } from '../ceremony/repositories/account-sessions.js';
import { hashSessionToken } from '../ceremony/passkey-authentication/crypto.js';
import { AppError } from '../errors/app-error.js';
import {
  PASSWORD_CHANGE_PUBLIC_ERROR_CODE,
  PASSWORD_CHANGE_PUBLIC_ERROR_MESSAGE,
} from '../ceremony/password-change/policy.js';

export type PasswordChangeRoutesOptions = {
  env: Env;
  now?: () => string;
  generateId?: () => string;
  generateToken?: () => string;
};

function assertPasswordChangeEnabled(env: Env, reply: { callNotFound: () => unknown }): boolean {
  if (!env.PASSWORD_CHANGE_ENABLED) {
    void reply.callNotFound();
    return false;
  }
  return true;
}

function sessionNotAuthorizedError(): AppError {
  return new AppError(401, 'SESSION_NOT_AUTHORIZED', 'Session is not authorized.');
}

function passwordChangeFailedError(): AppError {
  return new AppError(400, PASSWORD_CHANGE_PUBLIC_ERROR_CODE, PASSWORD_CHANGE_PUBLIC_ERROR_MESSAGE);
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
    throw sessionNotAuthorizedError();
  }
}

function rejectNonSessionSchemes(authorization: string | string[] | undefined): void {
  const raw = Array.isArray(authorization) ? authorization[0] : authorization;
  if (raw === undefined || raw.length === 0) {
    return;
  }
  const space = raw.indexOf(' ');
  if (space <= 0) {
    return;
  }
  const scheme = raw.slice(0, space);
  if (scheme === 'SetupGrant' || scheme === 'RecoveryGrant' || scheme === 'Bearer') {
    throw sessionNotAuthorizedError();
  }
}

export const passwordChangeRoutes: FastifyPluginCallbackTypebox<PasswordChangeRoutesOptions> = (
  app,
  options,
  done,
) => {
  const { env } = options;
  const now = () => (options.now ?? (() => new Date().toISOString()))();

  const buildDeps = (): PasswordChangeDeps => ({
    env,
    now,
    ...(options.generateId !== undefined ? { generateId: options.generateId } : {}),
    ...(options.generateToken !== undefined ? { generateToken: options.generateToken } : {}),
  });

  async function requireSession(request: {
    headers: {
      authorization?: string | string[] | undefined;
      origin?: string | string[] | undefined;
      'sec-fetch-site'?: string | string[] | undefined;
    };
    cookies?: Record<string, string | undefined>;
  }) {
    rejectNonSessionSchemes(request.headers.authorization);
    const config = requirePasswordChangeConfig(env);
    const extracted = extractSessionTransport({
      authorization: request.headers.authorization,
      cookieName: config.webSessionCookieName,
      cookies: request.cookies,
    });
    if (!extracted.ok) {
      throw sessionNotAuthorizedError();
    }
    if (extracted.clientType === 'web') {
      assertWebCsrf({
        originHeader: singleHeader(request.headers.origin),
        secFetchSite: singleHeader(request.headers['sec-fetch-site']),
        allowedOrigins: config.allowedOrigins,
      });
    }

    const tokenHash = hashSessionToken({
      hashKey: config.sessionTokenHashKey,
      clientType: extracted.clientType,
      token: extracted.token,
    });

    let session;
    try {
      session = await findActiveAccountSessionByTokenHash(app.database.db, {
        tokenHash,
        now: now(),
      });
    } catch {
      throw sessionNotAuthorizedError();
    }
    if (session.clientType !== extracted.clientType) {
      throw sessionNotAuthorizedError();
    }
    const account = await findAccountById(app.database.db, session.accountId);
    if (account?.status !== 'active') {
      throw sessionNotAuthorizedError();
    }

    return {
      session,
      clientType: extracted.clientType,
      token: extracted.token,
    };
  }

  app.post(
    '/v1/account/password/change',
    {
      schema: {
        tags: ['Account'],
        summary: 'Change the account password',
        description:
          'Changes the active password for a session-authenticated account. Requires the current password as fresh proof, validates the new password against initial-password policy, rotates the current session, and revokes all other sessions. Web clients authenticate with the Secure HttpOnly session cookie and must present same-origin/same-site CSRF evidence; mobile clients use Authorization: Session <token>. SetupGrant, RecoveryGrant, and Bearer are rejected. Disabled by default via PASSWORD_CHANGE_ENABLED. Independent of PASSWORD_AUTH_ENABLED, PASSWORD_SIGN_IN_ENABLED, and PASSKEY_AUTHENTICATION_ENABLED.',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        body: PasswordChangeBodySchema,
        response: PasswordChangeRouteResponses,
      },
    },
    async (request, reply) => {
      if (!assertPasswordChangeEnabled(env, reply)) {
        return;
      }

      try {
        const { session } = await requireSession({
          headers: request.headers,
          cookies: request.cookies,
        });
        const result = await changeAccountPassword(app.database.db, buildDeps(), {
          session,
          currentPassword: request.body.currentPassword,
          newPassword: request.body.newPassword,
          requestId: request.id,
        });

        if (result.clientType === 'web') {
          const config = requirePasswordChangeConfig(env);
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
        if (error instanceof RateLimitedError) {
          throw rateLimitedError();
        }
        if (error instanceof SessionNotAuthorizedError) {
          throw sessionNotAuthorizedError();
        }
        if (error instanceof PasswordChangeFailedError) {
          request.log.info(
            {
              requestId: request.id,
              route: 'password_change',
              outcome: 'failed',
              failureCategory: error.failureCategory,
            },
            'Password change failed',
          );
          throw passwordChangeFailedError();
        }
        if (error instanceof AppError) {
          throw error;
        }
        throw error;
      }
    },
  );

  done();
};

import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import type { Env } from '../config/env.js';
import { requirePasswordSignInConfig } from '../ceremony/password-authentication/config.js';
import {
  PasswordSignInBodySchema,
  PasswordSignInRouteResponses,
} from '../ceremony/password-authentication/schemas.js';
import {
  AuthenticationFailedError,
  authenticateWithPassword,
  type PasswordSignInDeps,
} from '../ceremony/password-authentication/service.js';
import { AppError } from '../errors/app-error.js';

export type PasswordAuthenticationRoutesOptions = {
  env: Env;
  now?: () => string;
  generateId?: () => string;
  generateToken?: () => string;
};

function assertPasswordSignInEnabled(env: Env, reply: { callNotFound: () => unknown }): boolean {
  if (!env.PASSWORD_SIGN_IN_ENABLED) {
    void reply.callNotFound();
    return false;
  }
  return true;
}

function authenticationFailedError(): AppError {
  return new AppError(400, 'AUTHENTICATION_FAILED', 'Authentication could not be completed.');
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

export const passwordAuthenticationRoutes: FastifyPluginCallbackTypebox<
  PasswordAuthenticationRoutesOptions
> = (app, options, done) => {
  const { env } = options;

  const now = () => (options.now ?? (() => new Date().toISOString()))();

  const buildDeps = (): PasswordSignInDeps => ({
    env,
    now,
    ...(options.generateId !== undefined ? { generateId: options.generateId } : {}),
    ...(options.generateToken !== undefined ? { generateToken: options.generateToken } : {}),
  });

  app.post(
    '/v1/authentication/password',
    {
      schema: {
        tags: ['Authentication'],
        summary: 'Sign in with email and password',
        description:
          'Authenticates an existing active account with email and password and creates a web or mobile session. Web sessions are returned only as a Secure HttpOnly __Host cookie. Mobile sessions are returned only in the JSON body for use as Authorization: Session <token>. Never creates or repairs accounts. All authentication failures return AUTHENTICATION_FAILED without revealing whether the email or account exists. Disabled by default via PASSWORD_SIGN_IN_ENABLED. Independent of PASSWORD_AUTH_ENABLED and PASSKEY_AUTHENTICATION_ENABLED.',
        body: PasswordSignInBodySchema,
        response: PasswordSignInRouteResponses.signIn,
      },
    },
    async (request, reply) => {
      if (!assertPasswordSignInEnabled(env, reply)) {
        return;
      }

      try {
        const result = await authenticateWithPassword(app.database.db, buildDeps(), {
          email: request.body.email,
          password: request.body.password,
          clientType: request.body.clientType,
          ip: request.ip,
          requestId: request.id,
        });

        if (result.clientType === 'web') {
          const config = requirePasswordSignInConfig(env);
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
              route: 'password_authentication',
              outcome: 'failed',
              failureCategory: error.failureCategory,
            },
            'Password authentication failed',
          );
        }
        throw authenticationFailedError();
      }
    },
  );

  done();
};

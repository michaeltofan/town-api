import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import type { Env } from '../config/env.js';
import { requirePasskeyManagementConfig } from '../ceremony/passkey-management/config.js';
import { assertWebCookieCsrf } from '../ceremony/passkey-authentication/csrf.js';
import {
  PasskeyIdParamsSchema,
  PasskeyManagementRouteResponses,
  PasskeyReauthenticationOptionsBodySchema,
  PasskeyReauthenticationVerifyBodySchema,
  PasskeyRenameBodySchema,
} from '../ceremony/passkey-management/schemas.js';
import {
  createPasskeyReauthenticationOptions,
  FreshAuthenticationRequiredError,
  InvalidPasskeyLabelRequestError,
  LastActivePasskeyRequiredError,
  listPasskeyInventory,
  PasskeyNotFoundError,
  PasskeyReauthenticationFailedError,
  RateLimitedError,
  renamePasskey,
  revokeManagedPasskey,
  SessionNotAuthorizedError,
  verifyPasskeyReauthentication,
  type PasskeyManagementDeps,
} from '../ceremony/passkey-management/service.js';
import {
  parseSessionAuthorizationHeader,
  parseWebSessionCookie,
  type SessionTransportExtraction,
} from '../ceremony/passkey-authentication/session-transport.js';
import { resolveActiveSession } from '../ceremony/passkey-authentication/service.js';
import { AppError } from '../errors/app-error.js';

export type PasskeyManagementRoutesOptions = {
  env: Env;
  now?: () => string;
  generateId?: () => string;
  generateToken?: () => string;
};

function assertPasskeyManagementEnabled(env: Env, reply: { callNotFound: () => unknown }): boolean {
  if (!env.PASSKEY_AUTHENTICATION_ENABLED) {
    void reply.callNotFound();
    return false;
  }
  return true;
}

function sessionNotAuthorizedError(): AppError {
  return new AppError(401, 'SESSION_NOT_AUTHORIZED', 'Session is not authorized.');
}

function freshAuthenticationRequiredError(): AppError {
  return new AppError(403, 'FRESH_AUTHENTICATION_REQUIRED', 'Fresh authentication is required.');
}

function passkeyNotFoundError(): AppError {
  return new AppError(404, 'PASSKEY_NOT_FOUND', 'Passkey was not found.');
}

function passkeyReauthenticationFailedError(): AppError {
  return new AppError(
    400,
    'PASSKEY_REAUTHENTICATION_FAILED',
    'Passkey reauthentication could not be completed.',
  );
}

function lastActivePasskeyRequiredError(): AppError {
  return new AppError(
    409,
    'LAST_ACTIVE_PASSKEY_REQUIRED',
    'At least one active passkey is required.',
  );
}

function rateLimitedError(): AppError {
  return new AppError(429, 'RATE_LIMITED', 'Rate limit exceeded.');
}

function invalidPasskeyLabelError(): AppError {
  return new AppError(400, 'INVALID_PASSKEY_LABEL', 'Passkey label is invalid.');
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

export const passkeyManagementRoutes: FastifyPluginCallbackTypebox<
  PasskeyManagementRoutesOptions
> = (app, options, done) => {
  const { env } = options;
  const now = () => (options.now ?? (() => new Date().toISOString()))();

  const buildDeps = (): PasskeyManagementDeps => ({
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

  async function requireSession(request: {
    headers: {
      authorization?: string | string[] | undefined;
      origin?: string | string[] | undefined;
      'sec-fetch-site'?: string | string[] | undefined;
    };
    cookies?: Record<string, string | undefined>;
    mutative?: boolean;
  }): Promise<{
    session: NonNullable<Awaited<ReturnType<typeof resolveActiveSession>>>;
    clientType: 'web' | 'mobile';
    token: string;
  }> {
    rejectNonSessionSchemes(request.headers.authorization);
    const config = requirePasskeyManagementConfig(env);
    const extracted = extractSessionTransport({
      authorization: request.headers.authorization,
      cookieName: config.webSessionCookieName,
      cookies: request.cookies,
    });
    if (!extracted.ok) {
      throw sessionNotAuthorizedError();
    }
    if (extracted.clientType === 'web' && request.mutative !== false) {
      assertWebCsrf({
        originHeader: singleHeader(request.headers.origin),
        secFetchSite: singleHeader(request.headers['sec-fetch-site']),
        allowedOrigins: config.allowedOrigins,
      });
    }
    const session = await resolveActiveSession(app.database.db, buildAuthDeps(), {
      clientType: extracted.clientType,
      token: extracted.token,
    });
    if (!session) {
      throw sessionNotAuthorizedError();
    }
    return { session, clientType: extracted.clientType, token: extracted.token };
  }

  app.get(
    '/v1/account/passkeys',
    {
      schema: {
        tags: ['Account'],
        summary: 'List active passkeys for the authenticated account',
        description:
          'Returns active passkeys for the session account. Exposes only opaque public passkey ids and safe metadata. Requires an active web or mobile session. SetupGrant, RecoveryGrant, and Bearer are rejected.',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        response: PasskeyManagementRouteResponses.inventory,
      },
    },
    async (request, reply) => {
      if (!assertPasskeyManagementEnabled(env, reply)) {
        return;
      }
      try {
        const { session } = await requireSession({
          headers: request.headers,
          cookies: request.cookies,
          mutative: false,
        });
        const result = await listPasskeyInventory(app.database.db, buildDeps(), {
          session,
          requestId: request.id,
        });
        return await reply.status(200).send({ data: result });
      } catch (error) {
        if (error instanceof RateLimitedError) {
          throw rateLimitedError();
        }
        if (error instanceof SessionNotAuthorizedError) {
          throw sessionNotAuthorizedError();
        }
        throw error;
      }
    },
  );

  app.post(
    '/v1/account/security/reauthentication/passkeys/options',
    {
      schema: {
        tags: ['Account'],
        summary: 'Create passkey reauthentication options for security freshness',
        description:
          'Issues PublicKeyCredentialRequestOptions bound to the current session for manage_passkeys_authenticate. User verification is required. Requires an active session.',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        body: PasskeyReauthenticationOptionsBodySchema,
        response: PasskeyManagementRouteResponses.reauthOptions,
      },
    },
    async (request, reply) => {
      if (!assertPasskeyManagementEnabled(env, reply)) {
        return;
      }
      try {
        const { session } = await requireSession({
          headers: request.headers,
          cookies: request.cookies,
        });
        const result = await createPasskeyReauthenticationOptions(app.database.db, buildDeps(), {
          session,
          requestId: request.id,
        });
        return await reply.status(200).send({
          data: {
            reauthenticationCeremonyId: result.reauthenticationCeremonyId,
            options: result.options,
          },
        });
      } catch (error) {
        if (error instanceof RateLimitedError) {
          throw rateLimitedError();
        }
        if (error instanceof SessionNotAuthorizedError) {
          throw sessionNotAuthorizedError();
        }
        if (error instanceof PasskeyReauthenticationFailedError) {
          throw passkeyReauthenticationFailedError();
        }
        throw error;
      }
    },
  );

  app.post(
    '/v1/account/security/reauthentication/passkeys/verify',
    {
      schema: {
        tags: ['Account'],
        summary: 'Verify passkey reauthentication and mark the session fresh',
        description:
          'Verifies a manage_passkeys_authenticate assertion, sets fresh_authenticated_at, rotates the session token, and returns FRESH_AUTHENTICATION_CONFIRMED. Web receives a replacement cookie only; mobile receives sessionToken in JSON only.',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        body: PasskeyReauthenticationVerifyBodySchema,
        response: PasskeyManagementRouteResponses.reauthVerify,
      },
    },
    async (request, reply) => {
      if (!assertPasskeyManagementEnabled(env, reply)) {
        return;
      }
      try {
        const { session } = await requireSession({
          headers: request.headers,
          cookies: request.cookies,
        });
        const result = await verifyPasskeyReauthentication(app.database.db, buildDeps(), {
          session,
          reauthenticationCeremonyId: request.body.reauthenticationCeremonyId,
          response: request.body.response as AuthenticationResponseJSON,
          requestId: request.id,
        });
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
              freshUntil: result.freshUntil,
            },
          });
        }
        return await reply.status(200).send({
          data: {
            status: result.status,
            freshUntil: result.freshUntil,
            sessionToken: result.rotation.rawToken,
            sessionExpiresAt: result.rotation.session.absoluteExpiresAt,
          },
        });
      } catch (error) {
        if (error instanceof RateLimitedError) {
          throw rateLimitedError();
        }
        if (error instanceof SessionNotAuthorizedError) {
          throw sessionNotAuthorizedError();
        }
        if (error instanceof PasskeyReauthenticationFailedError) {
          throw passkeyReauthenticationFailedError();
        }
        throw error;
      }
    },
  );

  app.patch(
    '/v1/account/passkeys/:passkeyId',
    {
      schema: {
        tags: ['Account'],
        summary: 'Rename an active passkey',
        description:
          'Updates the label of an active passkey owned by the session account. Does not require freshness. Same-value updates are idempotent without duplicate events.',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        params: PasskeyIdParamsSchema,
        body: PasskeyRenameBodySchema,
        response: PasskeyManagementRouteResponses.rename,
      },
    },
    async (request, reply) => {
      if (!assertPasskeyManagementEnabled(env, reply)) {
        return;
      }
      try {
        const { session } = await requireSession({
          headers: request.headers,
          cookies: request.cookies,
        });
        const result = await renamePasskey(app.database.db, buildDeps(), {
          session,
          passkeyId: request.params.passkeyId,
          label: request.body.label,
          requestId: request.id,
        });
        return await reply.status(200).send({ data: result });
      } catch (error) {
        if (error instanceof RateLimitedError) {
          throw rateLimitedError();
        }
        if (error instanceof SessionNotAuthorizedError) {
          throw sessionNotAuthorizedError();
        }
        if (error instanceof PasskeyNotFoundError) {
          throw passkeyNotFoundError();
        }
        if (error instanceof InvalidPasskeyLabelRequestError) {
          throw invalidPasskeyLabelError();
        }
        throw error;
      }
    },
  );

  app.delete(
    '/v1/account/passkeys/:passkeyId',
    {
      schema: {
        tags: ['Account'],
        summary: 'Revoke an active passkey',
        description:
          'Soft-revokes an active passkey. Requires freshness. Cannot revoke the last active passkey or the credential that authenticated the current session. Rotates the current session and revokes other sessions.',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        params: PasskeyIdParamsSchema,
        response: PasskeyManagementRouteResponses.revoke,
      },
    },
    async (request, reply) => {
      if (!assertPasskeyManagementEnabled(env, reply)) {
        return;
      }
      try {
        const { session } = await requireSession({
          headers: request.headers,
          cookies: request.cookies,
        });
        const result = await revokeManagedPasskey(app.database.db, buildDeps(), {
          session,
          passkeyId: request.params.passkeyId,
          requestId: request.id,
        });
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
            data: { status: result.status },
          });
        }
        return await reply.status(200).send({
          data: {
            status: result.status,
            sessionToken: result.rotation.rawToken,
            sessionExpiresAt: result.rotation.session.absoluteExpiresAt,
          },
        });
      } catch (error) {
        if (error instanceof RateLimitedError) {
          throw rateLimitedError();
        }
        if (error instanceof SessionNotAuthorizedError) {
          throw sessionNotAuthorizedError();
        }
        if (error instanceof FreshAuthenticationRequiredError) {
          throw freshAuthenticationRequiredError();
        }
        if (error instanceof PasskeyNotFoundError) {
          throw passkeyNotFoundError();
        }
        if (error instanceof LastActivePasskeyRequiredError) {
          throw lastActivePasskeyRequiredError();
        }
        throw error;
      }
    },
  );

  done();
};

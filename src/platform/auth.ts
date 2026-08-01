import type { Env } from '../config/env.js';
import { requirePasskeyManagementConfig } from '../ceremony/passkey-management/config.js';
import { assertWebCookieCsrf } from '../ceremony/passkey-authentication/csrf.js';
import {
  parseSessionAuthorizationHeader,
  parseWebSessionCookie,
  type SessionTransportExtraction,
} from '../ceremony/passkey-authentication/session-transport.js';
import { resolveActiveSession } from '../ceremony/passkey-authentication/service.js';
import type { Database } from '../db/client.js';
import type { PlatformOperatorRole } from '../db/schema.js';
import { findActivePlatformOperator } from './repositories/operators.js';
import { operatorHasCapability, type PlatformCapability } from './roles.js';

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
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

function rejectNonSessionSchemes(authorization: string | string[] | undefined): boolean {
  const raw = Array.isArray(authorization) ? authorization[0] : authorization;
  if (raw === undefined || raw.length === 0) {
    return false;
  }
  const space = raw.indexOf(' ');
  if (space <= 0) {
    return false;
  }
  const scheme = raw.slice(0, space);
  return scheme === 'SetupGrant' || scheme === 'RecoveryGrant' || scheme === 'Bearer';
}

export type PlatformOperatorSession = {
  accountId: string;
  role: PlatformOperatorRole;
};

export type PlatformAuthRequest = {
  headers: {
    authorization?: string | string[] | undefined;
    origin?: string | string[] | undefined;
    'sec-fetch-site'?: string | string[] | undefined;
  };
  cookies?: Record<string, string | undefined>;
};

/**
 * Resolve an active platform operator from the request session.
 * Fail closed: returns null for missing/invalid session or non-operator accounts.
 * Never trusts client claims for operator status — always reads platform_operators.
 */
export async function resolvePlatformOperator(
  db: Database['db'],
  env: Env,
  request: PlatformAuthRequest,
  now: () => string,
): Promise<PlatformOperatorSession | null> {
  if (rejectNonSessionSchemes(request.headers.authorization)) {
    return null;
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
  if (extracted.clientType === 'web') {
    const csrf = assertWebCookieCsrf({
      originHeader: singleHeader(request.headers.origin),
      secFetchSite: singleHeader(request.headers['sec-fetch-site']),
      allowedOrigins: config.allowedOrigins,
    });
    if (!csrf.ok) {
      return null;
    }
  }

  const session = await resolveActiveSession(
    db,
    { env, now },
    {
      clientType: extracted.clientType,
      token: extracted.token,
    },
  );
  if (!session) {
    return null;
  }

  const operator = await findActivePlatformOperator(db, session.accountId);
  if (!operator) {
    return null;
  }

  return {
    accountId: operator.accountId,
    role: operator.role as PlatformOperatorRole,
  };
}

export function requireOperatorCapability(
  operator: PlatformOperatorSession,
  capability: PlatformCapability,
): boolean {
  return operatorHasCapability(operator.role, capability);
}

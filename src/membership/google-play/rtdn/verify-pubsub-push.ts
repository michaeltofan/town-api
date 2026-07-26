import { OAuth2Client, type LoginTicket } from 'google-auth-library';

export const GOOGLE_OIDC_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

export type PubSubPushVerifier = (token: string) => Promise<void>;

type IdTokenVerifier = {
  verifyIdToken(options: { idToken: string; audience: string }): Promise<LoginTicket>;
};

export class PubSubPushAuthenticationError extends Error {
  constructor() {
    super('Pub/Sub push authentication failed.');
    this.name = 'PubSubPushAuthenticationError';
  }
}

export class PubSubPushVerifierUnavailableError extends Error {
  constructor() {
    super('Pub/Sub push verifier is unavailable.');
    this.name = 'PubSubPushVerifierUnavailableError';
  }
}

function isVerifierUnavailable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const record = error as {
    code?: unknown;
    response?: { status?: unknown };
    cause?: unknown;
  };
  const unavailableCodes = new Set([
    'EAI_AGAIN',
    'ECONNABORTED',
    'ECONNREFUSED',
    'ECONNRESET',
    'ENETDOWN',
    'ENETUNREACH',
    'ENOTFOUND',
    'ETIMEDOUT',
  ]);
  if (typeof record.code === 'string' && unavailableCodes.has(record.code)) {
    return true;
  }
  const status = record.response?.status;
  if (typeof status === 'number' && (status === 429 || status >= 500)) {
    return true;
  }
  return record.cause !== undefined && isVerifierUnavailable(record.cause);
}

export function createPubSubPushVerifier(
  config: {
    audience: string;
    serviceAccountEmail: string;
  },
  idTokenVerifier: IdTokenVerifier = new OAuth2Client(),
): PubSubPushVerifier {
  return async (token: string): Promise<void> => {
    let ticket: LoginTicket;
    try {
      // google-auth-library validates Google's rotating signature keys, iat,
      // exp, audience, issuer, and its built-in clock-skew allowance.
      ticket = await idTokenVerifier.verifyIdToken({
        idToken: token,
        audience: config.audience,
      });
    } catch (error) {
      if (isVerifierUnavailable(error)) {
        throw new PubSubPushVerifierUnavailableError();
      }
      throw new PubSubPushAuthenticationError();
    }

    const payload = ticket.getPayload();
    if (
      payload === undefined ||
      !GOOGLE_OIDC_ISSUERS.has(payload.iss) ||
      payload.aud !== config.audience ||
      payload.email !== config.serviceAccountEmail ||
      payload.email_verified !== true ||
      typeof payload.iat !== 'number' ||
      typeof payload.exp !== 'number'
    ) {
      throw new PubSubPushAuthenticationError();
    }
  };
}

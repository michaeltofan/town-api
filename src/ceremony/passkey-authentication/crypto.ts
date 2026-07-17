import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Opaque URL-safe session token from >= 32 cryptographically random bytes.
 * Never log the returned raw token.
 */
export function generateSessionToken(random: () => Buffer = () => randomBytes(32)): string {
  const bytes = random();
  if (bytes.length < 32) {
    throw new Error('Session token random source must provide at least 32 bytes');
  }
  return bytes.toString('base64url');
}

export function hashAuthenticationChallenge(input: {
  hashKey: string;
  challengeId: string;
  purpose: string;
  rpId: string;
  clientType: string;
  rawChallenge: string;
}): Buffer {
  const hmac = createHmac('sha256', input.hashKey);
  hmac.update('town.webauthn_auth_challenge.v1\0');
  hmac.update(input.challengeId);
  hmac.update('\0');
  hmac.update(input.purpose);
  hmac.update('\0');
  hmac.update(input.rpId);
  hmac.update('\0');
  hmac.update(input.clientType);
  hmac.update('\0');
  hmac.update(input.rawChallenge);
  return hmac.digest();
}

export function verifyAuthenticationChallengeHash(input: {
  hashKey: string;
  challengeId: string;
  purpose: string;
  rpId: string;
  clientType: string;
  rawChallenge: string;
  expectedHash: Buffer;
}): boolean {
  const actual = hashAuthenticationChallenge(input);
  if (actual.length !== input.expectedHash.length) {
    return false;
  }
  return timingSafeEqual(actual, input.expectedHash);
}

/**
 * Keyed session token hash bound to client type for transport separation.
 * Lookup uses the same client type derived from the extractor (web cookie vs Session auth).
 */
export function hashSessionToken(input: {
  hashKey: string;
  clientType: 'web' | 'mobile';
  token: string;
}): Buffer {
  const hmac = createHmac('sha256', input.hashKey);
  hmac.update('town.account_session.v1\0');
  hmac.update(input.clientType);
  hmac.update('\0');
  hmac.update(input.token);
  return hmac.digest();
}

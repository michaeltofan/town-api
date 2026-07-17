import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { WEBAUTHN_USER_HANDLE_BYTES } from './policy.js';

/**
 * Opaque 32-byte WebAuthn user handle. Not derived from email or public identifiers.
 * Never log the returned bytes.
 */
export function generateWebAuthnUserHandle(
  random: () => Buffer = () => randomBytes(WEBAUTHN_USER_HANDLE_BYTES),
): Buffer {
  const bytes = random();
  if (bytes.length !== WEBAUTHN_USER_HANDLE_BYTES) {
    throw new Error(
      `WebAuthn user handle random source must provide exactly ${String(WEBAUTHN_USER_HANDLE_BYTES)} bytes`,
    );
  }
  return bytes;
}

/**
 * HMAC-SHA-256 keyed hash binding challenge record id + purpose + account id + raw challenge.
 * Raw challenge must never be stored; only this digest is persisted.
 */
export function hashWebAuthnChallenge(input: {
  hashKey: string;
  challengeId: string;
  purpose: string;
  accountId: string;
  rawChallenge: string;
}): Buffer {
  const hmac = createHmac('sha256', input.hashKey);
  hmac.update('town.webauthn_challenge.v1\0');
  hmac.update(input.challengeId);
  hmac.update('\0');
  hmac.update(input.purpose);
  hmac.update('\0');
  hmac.update(input.accountId);
  hmac.update('\0');
  hmac.update(input.rawChallenge);
  return hmac.digest();
}

export function verifyWebAuthnChallengeHash(input: {
  hashKey: string;
  challengeId: string;
  purpose: string;
  accountId: string;
  rawChallenge: string;
  expectedHash: Buffer;
}): boolean {
  const actual = hashWebAuthnChallenge(input);
  if (actual.length !== input.expectedHash.length) {
    return false;
  }
  return timingSafeEqual(actual, input.expectedHash);
}

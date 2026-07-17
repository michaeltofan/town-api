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
 * Optional sessionId and rpId are appended for manage_* purposes only.
 * Raw challenge must never be stored; only this digest is persisted.
 */
export function hashWebAuthnChallenge(input: {
  hashKey: string;
  challengeId: string;
  purpose: string;
  accountId: string;
  rawChallenge: string;
  sessionId?: string;
  rpId?: string;
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
  if (input.sessionId !== undefined) {
    hmac.update('\0');
    hmac.update(input.sessionId);
  }
  if (input.rpId !== undefined) {
    hmac.update('\0');
    hmac.update(input.rpId);
  }
  return hmac.digest();
}

export function verifyWebAuthnChallengeHash(input: {
  hashKey: string;
  challengeId: string;
  purpose: string;
  accountId: string;
  rawChallenge: string;
  expectedHash: Buffer;
  sessionId?: string;
  rpId?: string;
}): boolean {
  const actual = hashWebAuthnChallenge(input);
  if (actual.length !== input.expectedHash.length) {
    return false;
  }
  return timingSafeEqual(actual, input.expectedHash);
}

/** Manage-purpose challenge binding: challengeId+rawChallenge+purpose+accountId+sessionId+rpId. */
export function hashManageWebAuthnChallenge(input: {
  hashKey: string;
  challengeId: string;
  purpose: 'manage_passkeys_authenticate' | 'manage_passkeys_register';
  accountId: string;
  sessionId: string;
  rpId: string;
  rawChallenge: string;
}): Buffer {
  return hashWebAuthnChallenge({
    hashKey: input.hashKey,
    challengeId: input.challengeId,
    purpose: input.purpose,
    accountId: input.accountId,
    rawChallenge: input.rawChallenge,
    sessionId: input.sessionId,
    rpId: input.rpId,
  });
}

export function verifyManageWebAuthnChallengeHash(input: {
  hashKey: string;
  challengeId: string;
  purpose: 'manage_passkeys_authenticate' | 'manage_passkeys_register';
  accountId: string;
  sessionId: string;
  rpId: string;
  rawChallenge: string;
  expectedHash: Buffer;
}): boolean {
  return verifyWebAuthnChallengeHash({
    hashKey: input.hashKey,
    challengeId: input.challengeId,
    purpose: input.purpose,
    accountId: input.accountId,
    rawChallenge: input.rawChallenge,
    expectedHash: input.expectedHash,
    sessionId: input.sessionId,
    rpId: input.rpId,
  });
}

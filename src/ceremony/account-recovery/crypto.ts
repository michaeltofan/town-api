import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { generateVerificationCode } from '../email-verification/crypto.js';

export { generateVerificationCode, hashRateLimitSubject } from '../email-verification/crypto.js';

/**
 * HMAC-SHA-256 keyed hash binding challenge id + purpose + account id + raw code.
 * Raw code must never be stored; only this digest is persisted.
 */
export function hashRecoveryCode(input: {
  hashKey: string;
  challengeId: string;
  purpose: string;
  accountId: string;
  code: string;
}): Buffer {
  const hmac = createHmac('sha256', input.hashKey);
  hmac.update('town.account_recovery.v1\0');
  hmac.update(input.challengeId);
  hmac.update('\0');
  hmac.update(input.purpose);
  hmac.update('\0');
  hmac.update(input.accountId);
  hmac.update('\0');
  hmac.update(input.code);
  return hmac.digest();
}

export function verifyRecoveryCode(input: {
  hashKey: string;
  challengeId: string;
  purpose: string;
  accountId: string;
  code: string;
  expectedHash: Buffer;
}): boolean {
  const actual = hashRecoveryCode(input);
  if (actual.length !== input.expectedHash.length) {
    return false;
  }
  return timingSafeEqual(actual, input.expectedHash);
}

/**
 * Opaque URL-safe recovery grant token from >= 32 cryptographically random bytes.
 * Never log or persist the returned raw token.
 */
export function generateRecoveryGrantToken(random: () => Buffer = () => randomBytes(32)): string {
  const bytes = random();
  if (bytes.length < 32) {
    throw new Error('Recovery grant token random source must provide at least 32 bytes');
  }
  return bytes.toString('base64url');
}

export function hashRecoveryGrantToken(input: {
  hashKey: string;
  purpose: string;
  token: string;
}): Buffer {
  const hmac = createHmac('sha256', input.hashKey);
  hmac.update('town.account_recovery_grant.v1\0');
  hmac.update(input.purpose);
  hmac.update('\0');
  hmac.update(input.token);
  return hmac.digest();
}

/** Re-export for callers that want a stable recovery code generator alias. */
export const generateRecoveryCode = generateVerificationCode;

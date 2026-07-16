import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const CODE_ALPHABET_SIZE = 1_000_000;

/**
 * Cryptographically secure six-digit decimal code (leading zeroes allowed).
 * Never log or persist the returned raw code.
 */
export function generateVerificationCode(random: () => Buffer = () => randomBytes(4)): string {
  // Rejection sampling avoids modulo bias for 2^32 % 1_000_000.
  for (;;) {
    const buf = random();
    if (buf.length < 4) {
      throw new Error('Verification code random source must provide at least 4 bytes');
    }
    const value = buf.readUInt32BE(0);
    if (value < Math.floor(0x1_0000_0000 / CODE_ALPHABET_SIZE) * CODE_ALPHABET_SIZE) {
      return String(value % CODE_ALPHABET_SIZE).padStart(6, '0');
    }
  }
}

/**
 * HMAC-SHA-256 keyed hash binding challenge id + purpose + raw code.
 * Raw code must never be stored; only this digest is persisted.
 */
export function hashVerificationCode(input: {
  hashKey: string;
  challengeId: string;
  purpose: string;
  code: string;
}): Buffer {
  const hmac = createHmac('sha256', input.hashKey);
  hmac.update('town.email_verification.v1\0');
  hmac.update(input.challengeId);
  hmac.update('\0');
  hmac.update(input.purpose);
  hmac.update('\0');
  hmac.update(input.code);
  return hmac.digest();
}

export function verifyVerificationCode(input: {
  hashKey: string;
  challengeId: string;
  purpose: string;
  code: string;
  expectedHash: Buffer;
}): boolean {
  const actual = hashVerificationCode(input);
  if (actual.length !== input.expectedHash.length) {
    return false;
  }
  return timingSafeEqual(actual, input.expectedHash);
}

/**
 * Opaque URL-safe setup grant token from >= 32 cryptographically random bytes.
 */
export function generateSetupGrantToken(random: () => Buffer = () => randomBytes(32)): string {
  const bytes = random();
  if (bytes.length < 32) {
    throw new Error('Setup grant token random source must provide at least 32 bytes');
  }
  return bytes.toString('base64url');
}

export function hashOpaqueToken(input: {
  hashKey: string;
  purpose: string;
  token: string;
}): Buffer {
  const hmac = createHmac('sha256', input.hashKey);
  hmac.update('town.setup_grant.v1\0');
  hmac.update(input.purpose);
  hmac.update('\0');
  hmac.update(input.token);
  return hmac.digest();
}

export function hashRateLimitSubject(input: {
  hashKey: string;
  scope: string;
  subject: string;
}): Buffer {
  const hmac = createHmac('sha256', input.hashKey);
  hmac.update('town.ceremony_rate_limit.v1\0');
  hmac.update(input.scope);
  hmac.update('\0');
  hmac.update(input.subject);
  return hmac.digest();
}

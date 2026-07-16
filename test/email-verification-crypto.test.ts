import { describe, expect, it } from 'vitest';
import {
  generateSetupGrantToken,
  generateVerificationCode,
  hashVerificationCode,
  verifyVerificationCode,
} from '../src/ceremony/email-verification/crypto.js';

describe('email verification crypto', () => {
  it('generates six-digit codes including leading zeroes via crypto bytes', () => {
    const zeroCode = generateVerificationCode(() => {
      const buf = Buffer.alloc(4);
      buf.writeUInt32BE(0);
      return buf;
    });
    expect(zeroCode).toBe('000000');

    const sample = generateVerificationCode();
    expect(sample).toMatch(/^\d{6}$/);
  });

  it('verifies HMAC hashes with constant-time equality', () => {
    const hashKey = 'town-test-email-verification-hash-key-32';
    const hash = hashVerificationCode({
      hashKey,
      challengeId: '11111111-1111-4111-8111-111111111111',
      purpose: 'verify_email',
      code: '012345',
    });
    expect(
      verifyVerificationCode({
        hashKey,
        challengeId: '11111111-1111-4111-8111-111111111111',
        purpose: 'verify_email',
        code: '012345',
        expectedHash: hash,
      }),
    ).toBe(true);
    expect(
      verifyVerificationCode({
        hashKey,
        challengeId: '11111111-1111-4111-8111-111111111111',
        purpose: 'verify_email',
        code: '012346',
        expectedHash: hash,
      }),
    ).toBe(false);
  });

  it('generates URL-safe setup tokens from at least 32 random bytes', () => {
    const token = generateSetupGrantToken(() => Buffer.alloc(32, 7));
    expect(token.length).toBeGreaterThan(0);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(() => generateSetupGrantToken(() => Buffer.alloc(8))).toThrow(/32/);
  });
});

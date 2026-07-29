import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/identity/password-hashing.js';
import {
  INITIAL_PASSWORD_MAX_CODE_POINTS,
  INITIAL_PASSWORD_MIN_CODE_POINTS,
  normalizeAndValidateInitialPassword,
  PasswordPolicyError,
  passwordCodePointLength,
} from '../src/identity/password-policy.js';

describe('initial password policy', () => {
  it('rejects 14 code points and accepts 15', () => {
    expect(() => normalizeAndValidateInitialPassword('a'.repeat(14))).toThrow(PasswordPolicyError);
    expect(normalizeAndValidateInitialPassword('a'.repeat(15))).toBe('a'.repeat(15));
  });

  it('accepts 128 code points and rejects 129', () => {
    expect(normalizeAndValidateInitialPassword('b'.repeat(128))).toBe('b'.repeat(128));
    expect(() => normalizeAndValidateInitialPassword('b'.repeat(129))).toThrow(PasswordPolicyError);
  });

  it('accepts spaces and does not trim', () => {
    const withSpaces = `  ${'c'.repeat(13)}  `;
    expect(passwordCodePointLength(withSpaces)).toBe(17);
    expect(normalizeAndValidateInitialPassword(withSpaces)).toBe(withSpaces);
  });

  it('accepts Unicode and does not silently truncate', () => {
    const unicode = 'пароль-безопасн'; // 15 code points
    expect(passwordCodePointLength(unicode)).toBe(INITIAL_PASSWORD_MIN_CODE_POINTS);
    expect(normalizeAndValidateInitialPassword(unicode)).toBe(unicode);

    const tooLong = `${'字'.repeat(INITIAL_PASSWORD_MAX_CODE_POINTS)}extra`;
    expect(() => normalizeAndValidateInitialPassword(tooLong)).toThrow(PasswordPolicyError);
  });

  it('never includes the password in the policy error', () => {
    try {
      normalizeAndValidateInitialPassword('secret-password');
      expect.unreachable('expected policy rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(PasswordPolicyError);
      expect(String(error)).not.toContain('secret-password');
    }
  });

  it('normalizes composed and decomposed Unicode to the same hash/verify result', async () => {
    // é as composed U+00E9 vs e + combining acute U+0065 U+0301
    const composed = `cafe\u00e9-${'x'.repeat(9)}`;
    const decomposed = `cafe\u0065\u0301-${'x'.repeat(9)}`;
    expect(composed).not.toBe(decomposed);

    const acceptedComposed = normalizeAndValidateInitialPassword(composed);
    const acceptedDecomposed = normalizeAndValidateInitialPassword(decomposed);
    expect(acceptedComposed).toBe(acceptedDecomposed);

    const hashed = await hashPassword(acceptedComposed);
    await expect(verifyPassword(composed, hashed.hash)).resolves.toBe(true);
    await expect(verifyPassword(decomposed, hashed.hash)).resolves.toBe(true);
  });
});

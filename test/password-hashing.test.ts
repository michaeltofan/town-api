import { describe, expect, it } from 'vitest';
import {
  hashPassword,
  verifyPassword,
  verifyPasswordStrict,
} from '../src/identity/password-hashing.js';
import {
  PASSWORD_ARGON2_MEMORY_COST_KIB,
  PASSWORD_ARGON2_OUTPUT_LEN,
  PASSWORD_ARGON2_PARALLELISM,
  PASSWORD_ARGON2_TIME_COST,
  PASSWORD_KDF_ALGORITHM,
  PASSWORD_KDF_VERSION,
} from '../src/identity/password-policy.js';

describe('password hashing', () => {
  it('hashes with argon2id and verifies the correct plaintext', async () => {
    const result = await hashPassword('correct-horse-battery-staple');

    expect(result.algorithm).toBe(PASSWORD_KDF_ALGORITHM);
    expect(result.parameters).toEqual({
      memoryCost: PASSWORD_ARGON2_MEMORY_COST_KIB,
      timeCost: PASSWORD_ARGON2_TIME_COST,
      parallelism: PASSWORD_ARGON2_PARALLELISM,
      version: PASSWORD_KDF_VERSION,
      outputLen: PASSWORD_ARGON2_OUTPUT_LEN,
    });
    expect(result.hash.startsWith('$argon2id$')).toBe(true);
    expect(result.hash).toContain(`m=${String(PASSWORD_ARGON2_MEMORY_COST_KIB)}`);
    expect(result.hash).toContain(`t=${String(PASSWORD_ARGON2_TIME_COST)}`);
    expect(result.hash).toContain(`p=${String(PASSWORD_ARGON2_PARALLELISM)}`);
    expect(result.hash).not.toContain('correct-horse-battery-staple');

    await expect(verifyPassword('correct-horse-battery-staple', result.hash)).resolves.toBe(true);
  });

  it('rejects the wrong password', async () => {
    const result = await hashPassword('correct-horse-battery-staple');
    await expect(verifyPassword('wrong-password', result.hash)).resolves.toBe(false);
  });

  it('rejects a tampered hash without throwing', async () => {
    const result = await hashPassword('correct-horse-battery-staple');
    const tampered = `${result.hash.slice(0, -4)}xxxx`;
    await expect(verifyPassword('correct-horse-battery-staple', tampered)).resolves.toBe(false);
  });

  it('rejects empty plaintext on hash and verify', async () => {
    await expect(hashPassword('')).rejects.toThrow(/non-empty/);
    await expect(verifyPassword('', '$argon2id$v=19$m=19456,t=2,p=1$aaaa$bbbb')).resolves.toBe(
      false,
    );
  });
});

describe('verifyPasswordStrict', () => {
  it('returns true for the correct plaintext', async () => {
    const result = await hashPassword('correct-horse-battery-staple');
    await expect(verifyPasswordStrict('correct-horse-battery-staple', result.hash)).resolves.toBe(
      true,
    );
  });

  it('returns false for a wrong password against a valid hash', async () => {
    const result = await hashPassword('correct-horse-battery-staple');
    await expect(verifyPasswordStrict('wrong-password', result.hash)).resolves.toBe(false);
  });

  it('returns false for empty plaintext', async () => {
    const result = await hashPassword('correct-horse-battery-staple');
    await expect(verifyPasswordStrict('', result.hash)).resolves.toBe(false);
  });

  it('throws for empty or missing stored hash', async () => {
    await expect(verifyPasswordStrict('correct-horse-battery-staple', '')).rejects.toThrow(
      /non-empty/,
    );
  });

  it('rethrows malformed PHC / Argon2 verify failures', async () => {
    await expect(
      verifyPasswordStrict('correct-horse-battery-staple', 'not-a-valid-phc'),
    ).rejects.toThrow();
  });

  it('does not change verifyPassword swallow behavior for tampered hashes', async () => {
    const result = await hashPassword('correct-horse-battery-staple');
    const tampered = `${result.hash.slice(0, -4)}xxxx`;
    await expect(verifyPassword('correct-horse-battery-staple', tampered)).resolves.toBe(false);
  });
});

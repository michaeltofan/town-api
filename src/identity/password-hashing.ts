import { hash, verify, type Options } from '@node-rs/argon2';
import {
  normalizePasswordForHashing,
  PASSWORD_ARGON2_MEMORY_COST_KIB,
  PASSWORD_ARGON2_OUTPUT_LEN,
  PASSWORD_ARGON2_PARALLELISM,
  PASSWORD_ARGON2_TIME_COST,
  PASSWORD_KDF_ALGORITHM,
  PASSWORD_KDF_PARAMETERS,
  type PasswordKdfParameters,
} from './password-policy.js';

/** Numeric Algorithm.Argon2id / Version.V0x13 — avoid ambient const enum imports under verbatimModuleSyntax. */
const HASH_OPTIONS: Options = {
  algorithm: 2,
  version: 1,
  memoryCost: PASSWORD_ARGON2_MEMORY_COST_KIB,
  timeCost: PASSWORD_ARGON2_TIME_COST,
  parallelism: PASSWORD_ARGON2_PARALLELISM,
  outputLen: PASSWORD_ARGON2_OUTPUT_LEN,
};

export type PasswordHashResult = {
  /** PHC-encoded Argon2id string (includes algorithm, params, salt, digest). Never log. */
  readonly hash: string;
  readonly algorithm: typeof PASSWORD_KDF_ALGORITHM;
  readonly parameters: PasswordKdfParameters;
};

/**
 * Hash a plaintext password with Argon2id using pinned OWASP-safe parameters.
 * Applies NFC normalization so hash and verify share one rule.
 * Callers must validate initial-password policy before calling this for setup.
 * Never log `plaintext` or the returned hash in application logs.
 *
 * Does not apply PASSWORD_HASH_PEPPER — pepper remains reserved/unimplemented.
 */
export async function hashPassword(plaintext: string): Promise<PasswordHashResult> {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('Password plaintext must be a non-empty string');
  }

  const normalized = normalizePasswordForHashing(plaintext);
  const encoded = await hash(normalized, HASH_OPTIONS);
  return {
    hash: encoded,
    algorithm: PASSWORD_KDF_ALGORITHM,
    parameters: PASSWORD_KDF_PARAMETERS,
  };
}

/**
 * Verify plaintext against a stored PHC password hash.
 * Applies the same NFC normalization as hashing.
 * Returns false for mismatches and for malformed/tampered hashes (never throws on verify failure).
 * Underlying Argon2 verify is constant-time for valid hashes of equal structure.
 */
export async function verifyPassword(plaintext: string, storedHash: string): Promise<boolean> {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    return false;
  }
  if (typeof storedHash !== 'string' || storedHash.length === 0) {
    return false;
  }

  try {
    const normalized = normalizePasswordForHashing(plaintext);
    return await verify(storedHash, normalized);
  } catch {
    return false;
  }
}

/**
 * Strict verify for session-authenticated password change.
 * - Empty plaintext → false (caller maps to password_mismatch).
 * - Empty/missing stored hash → throw (caller maps to 500; no failure event).
 * - Valid hash + wrong password → false.
 * - Malformed PHC / Argon2 / runtime exceptions → rethrow (no catch).
 * Does not change verifyPassword behavior used by password sign-in.
 */
export async function verifyPasswordStrict(
  plaintext: string,
  storedHash: string,
): Promise<boolean> {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    return false;
  }
  if (typeof storedHash !== 'string' || storedHash.length === 0) {
    throw new Error('Stored password hash must be a non-empty string');
  }

  const normalized = normalizePasswordForHashing(plaintext);
  return await verify(storedHash, normalized);
}

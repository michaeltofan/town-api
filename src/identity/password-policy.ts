/**
 * Password credential KDF policy and initial password strength policy.
 * KDF parameters follow OWASP Argon2id recommendations (m=19456 KiB, t=2, p=1).
 *
 * PASSWORD_HASH_PEPPER remains reserved for a future slice and is intentionally
 * unused by hashing. Do not invent pepper application here.
 */
export const PASSWORD_KDF_ALGORITHM = 'argon2id' as const;

/** Argon2 version encoded in PHC strings (0x13 = 19). */
export const PASSWORD_KDF_VERSION = 19 as const;

/** Memory cost in kibibytes (19 MiB). */
export const PASSWORD_ARGON2_MEMORY_COST_KIB = 19_456;

/** Time cost (passes). */
export const PASSWORD_ARGON2_TIME_COST = 2;

/** Parallelism (lanes/threads). */
export const PASSWORD_ARGON2_PARALLELISM = 1;

/** Output digest length in bytes. */
export const PASSWORD_ARGON2_OUTPUT_LEN = 32;

/** Minimum length for optional future PASSWORD_HASH_PEPPER when auth is enabled. */
export const PASSWORD_HASH_PEPPER_MIN_LENGTH = 32;

/** Minimum Unicode code points for initial password setup. */
export const INITIAL_PASSWORD_MIN_CODE_POINTS = 15;

/** Maximum Unicode code points for initial password setup. */
export const INITIAL_PASSWORD_MAX_CODE_POINTS = 128;

export type PasswordKdfAlgorithm = typeof PASSWORD_KDF_ALGORITHM;

export type PasswordKdfParameters = {
  readonly memoryCost: typeof PASSWORD_ARGON2_MEMORY_COST_KIB;
  readonly timeCost: typeof PASSWORD_ARGON2_TIME_COST;
  readonly parallelism: typeof PASSWORD_ARGON2_PARALLELISM;
  readonly version: typeof PASSWORD_KDF_VERSION;
  readonly outputLen: typeof PASSWORD_ARGON2_OUTPUT_LEN;
};

export const PASSWORD_KDF_PARAMETERS: PasswordKdfParameters = {
  memoryCost: PASSWORD_ARGON2_MEMORY_COST_KIB,
  timeCost: PASSWORD_ARGON2_TIME_COST,
  parallelism: PASSWORD_ARGON2_PARALLELISM,
  version: PASSWORD_KDF_VERSION,
  outputLen: PASSWORD_ARGON2_OUTPUT_LEN,
};

/**
 * Bounded policy rejection. Never include the password in the message.
 */
export class PasswordPolicyError extends Error {
  readonly code = 'PASSWORD_POLICY_VIOLATION';

  constructor() {
    super('Password does not meet policy requirements.');
    this.name = 'PasswordPolicyError';
  }
}

/** Unicode code-point length (not UTF-16 code units). Does not trim. */
export function passwordCodePointLength(value: string): number {
  return Array.from(value).length;
}

/**
 * Normalize password input to NFC for hashing and verification.
 * Callers must validate policy before hashing; this only applies Unicode NFC.
 */
export function normalizePasswordForHashing(plaintext: string): string {
  return plaintext.normalize('NFC');
}

/**
 * Validate and normalize an initial password before hashing.
 * - Counts Unicode code points after NFC (consistent with hash/verify).
 * - Does not trim; does not silently truncate.
 * - Accepts spaces and Unicode; no composition rules.
 * Never includes the password in the thrown error.
 */
export function normalizeAndValidateInitialPassword(plaintext: string): string {
  if (typeof plaintext !== 'string') {
    throw new PasswordPolicyError();
  }

  const normalized = normalizePasswordForHashing(plaintext);
  const length = passwordCodePointLength(normalized);
  if (length < INITIAL_PASSWORD_MIN_CODE_POINTS || length > INITIAL_PASSWORD_MAX_CODE_POINTS) {
    throw new PasswordPolicyError();
  }
  return normalized;
}

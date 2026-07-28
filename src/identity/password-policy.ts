/**
 * Password credential KDF policy for the inert password-auth foundation slice.
 * Parameters follow OWASP Argon2id recommendations (m=19456 KiB, t=2, p=1).
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

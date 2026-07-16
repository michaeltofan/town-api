import { createHash } from 'node:crypto';

/**
 * Test-safe deterministic SHA-256 helper for identity fixtures and repository tests.
 * Production secret generation is out of scope for this foundation slice.
 * Repositories accept only pre-hashed bytes — never raw codes/tokens/challenges.
 */
export function deterministicSha256(input: string | Buffer): Buffer {
  const hash = createHash('sha256');
  if (typeof input === 'string') {
    hash.update(input, 'utf8');
  } else {
    hash.update(input);
  }
  return hash.digest();
}

export function assertHashedBytes(value: Buffer, label: string): Buffer {
  if (!Buffer.isBuffer(value) || value.length === 0) {
    throw new Error(`${label} must be non-empty hashed bytes`);
  }
  return value;
}

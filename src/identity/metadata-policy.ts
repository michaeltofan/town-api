const FORBIDDEN_METADATA_KEYS = new Set([
  'code',
  'token',
  'secret',
  'raw',
  'privateKey',
  'private_key',
  'password',
  'biometric',
  'headers',
  'authorization',
  'cookie',
  'challenge',
]);

/**
 * Bound optional identity event metadata. Rejects known sensitive key names.
 */
export function sanitizeIdentityMetadata(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (metadata === undefined || metadata === null) {
    return null;
  }

  const entries = Object.entries(metadata);
  if (entries.length > 16) {
    throw new Error('Identity event metadata exceeds bounded size');
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    if (FORBIDDEN_METADATA_KEYS.has(key)) {
      throw new Error('Identity event metadata contains a forbidden field');
    }
    if (typeof value === 'string' && value.length > 256) {
      throw new Error('Identity event metadata string value exceeds bound');
    }
    if (value !== null && typeof value === 'object') {
      throw new Error('Identity event metadata nesting is not allowed');
    }
    sanitized[key] = value;
  }

  return sanitized;
}

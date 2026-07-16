/**
 * Conservative email normalization for TOWN account identity.
 *
 * - trim surrounding whitespace
 * - lowercase the domain only
 * - preserve local-part characters, casing, dots, and plus tags
 * - no Gmail / provider-specific rewriting
 */
export function normalizeEmail(input: string): string {
  if (typeof input !== 'string') {
    throw new Error('Email must be a string');
  }

  const trimmed = input.trim();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1) {
    throw new Error('Email must contain a local-part and domain');
  }

  const localPart = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);

  if (localPart.length === 0 || domain.length === 0) {
    throw new Error('Email must contain a local-part and domain');
  }

  if (localPart.includes(' ') || domain.includes(' ') || domain.includes('@')) {
    throw new Error('Email format is invalid');
  }

  if (!domain.includes('.')) {
    throw new Error('Email domain is invalid');
  }

  return `${localPart}@${domain.toLowerCase()}`;
}

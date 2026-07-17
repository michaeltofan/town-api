import { PASSKEY_LABEL_MAX_CODE_POINTS } from './policy.js';

export class InvalidPasskeyLabelError extends Error {
  readonly code = 'INVALID_PASSKEY_LABEL';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidPasskeyLabelError';
  }
}

/**
 * Normalize a passkey label: trim, reject control/null bytes, max 64 code points.
 * Empty after trim becomes null.
 */
export function normalizeLabel(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  if (typeof raw !== 'string') {
    throw new InvalidPasskeyLabelError('Label must be a string');
  }
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    if (code === 0 || (code >= 1 && code <= 31) || code === 127) {
      throw new InvalidPasskeyLabelError('Label contains control characters');
    }
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  // Labels are plain text; code-point length is intentional (not grapheme clusters).
  // eslint-disable-next-line @typescript-eslint/no-misused-spread -- counting Unicode code points
  const codePoints = [...trimmed];
  if (codePoints.length > PASSKEY_LABEL_MAX_CODE_POINTS) {
    throw new InvalidPasskeyLabelError('Label exceeds maximum length');
  }
  return trimmed;
}

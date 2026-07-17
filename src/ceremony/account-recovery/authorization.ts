/**
 * Focused RecoveryGrant Authorization parser for account recovery routes.
 * Does not conflate recovery grants with account sessions, setup grants, or Bearer tokens.
 */

export type RecoveryGrantAuthorization =
  { ok: true; token: string } | { ok: false; reason: 'missing' | 'malformed' };

const SCHEME = 'RecoveryGrant';

export function parseRecoveryGrantAuthorization(
  header: string | string[] | undefined,
): RecoveryGrantAuthorization {
  if (header === undefined) {
    return { ok: false, reason: 'missing' };
  }
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw === undefined || raw.length === 0) {
    return { ok: false, reason: 'missing' };
  }

  const space = raw.indexOf(' ');
  if (space <= 0) {
    return { ok: false, reason: 'malformed' };
  }
  const scheme = raw.slice(0, space);
  const token = raw.slice(space + 1).trim();
  if (scheme !== SCHEME || token.length === 0 || token.includes(' ')) {
    return { ok: false, reason: 'malformed' };
  }
  return { ok: true, token };
}

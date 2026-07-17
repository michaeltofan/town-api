/**
 * Focused SetupGrant Authorization parser for passkey registration routes.
 * Does not conflate setup grants with account sessions or Bearer tokens.
 */

export type SetupGrantAuthorization =
  { ok: true; token: string } | { ok: false; reason: 'missing' | 'malformed' };

const SCHEME = 'SetupGrant';

export function parseSetupGrantAuthorization(
  header: string | string[] | undefined,
): SetupGrantAuthorization {
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

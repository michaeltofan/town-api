/**
 * Focused session transport extractors.
 * Web: exact cookie only. Mobile: exact Authorization: Session only.
 * No transport fallback between web and mobile.
 */

export type SessionTransportExtraction =
  { ok: true; clientType: 'web' | 'mobile'; token: string } | { ok: false; reason: string };

export function parseSessionAuthorizationHeader(
  header: string | string[] | undefined,
): SessionTransportExtraction {
  if (header === undefined) {
    return { ok: false, reason: 'missing_authorization' };
  }
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw === undefined || raw.length === 0) {
    return { ok: false, reason: 'missing_authorization' };
  }
  const space = raw.indexOf(' ');
  if (space <= 0) {
    return { ok: false, reason: 'malformed_authorization' };
  }
  const scheme = raw.slice(0, space);
  const token = raw.slice(space + 1).trim();
  if (scheme !== 'Session' || token.length === 0 || token.includes(' ')) {
    return { ok: false, reason: 'malformed_authorization' };
  }
  return { ok: true, clientType: 'mobile', token };
}

export function parseWebSessionCookie(input: {
  cookieName: string;
  cookies: Record<string, string | undefined> | undefined;
}): SessionTransportExtraction {
  if (!input.cookies) {
    return { ok: false, reason: 'missing_cookie' };
  }
  const token = input.cookies[input.cookieName];
  if (typeof token !== 'string' || token.length === 0) {
    return { ok: false, reason: 'missing_cookie' };
  }
  return { ok: true, clientType: 'web', token };
}

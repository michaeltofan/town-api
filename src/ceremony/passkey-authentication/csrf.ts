/**
 * CSRF boundary for mutative cookie-authenticated web session routes.
 * Preferred: Origin exactly matches an allowed web origin.
 * Fallback when Origin is legitimately absent: Sec-Fetch-Site same-origin or same-site.
 */

export type CsrfCheckResult = { ok: true } | { ok: false; reason: string };

export function assertWebCookieCsrf(input: {
  originHeader: string | undefined;
  secFetchSite: string | undefined;
  allowedOrigins: readonly string[];
}): CsrfCheckResult {
  const origin = input.originHeader?.trim();
  if (origin && origin.length > 0) {
    if (input.allowedOrigins.includes(origin)) {
      return { ok: true };
    }
    return { ok: false, reason: 'origin_mismatch' };
  }

  const site = input.secFetchSite?.trim().toLowerCase();
  if (site === 'same-origin' || site === 'same-site') {
    return { ok: true };
  }
  return { ok: false, reason: 'csrf_missing_or_cross_site' };
}

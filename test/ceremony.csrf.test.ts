import { describe, expect, it } from 'vitest';
import { assertWebCookieCsrf } from '../src/ceremony/passkey-authentication/csrf.js';

const PRODUCTION_ORIGIN = 'https://towncivic.org';
const RAILWAY_ORIGIN = 'https://town-public-staging-staging.up.railway.app';
const MADRID_ORIGIN = 'https://madrid-staging.towncivic.org';
const STAGING_ALLOWED_ORIGINS = [PRODUCTION_ORIGIN, RAILWAY_ORIGIN, MADRID_ORIGIN] as const;

describe('assertWebCookieCsrf', () => {
  it('accepts an exact Origin match', () => {
    expect(
      assertWebCookieCsrf({
        originHeader: PRODUCTION_ORIGIN,
        secFetchSite: undefined,
        allowedOrigins: [PRODUCTION_ORIGIN],
      }),
    ).toEqual({ ok: true });
  });

  it('rejects an Origin not on the allowlist', () => {
    expect(
      assertWebCookieCsrf({
        originHeader: 'https://evil.example',
        secFetchSite: undefined,
        allowedOrigins: [PRODUCTION_ORIGIN],
      }),
    ).toEqual({ ok: false, reason: 'origin_mismatch' });
  });

  it('falls back to same-origin/same-site Sec-Fetch-Site when Origin is absent', () => {
    expect(
      assertWebCookieCsrf({
        originHeader: undefined,
        secFetchSite: 'same-origin',
        allowedOrigins: [PRODUCTION_ORIGIN],
      }),
    ).toEqual({ ok: true });
    expect(
      assertWebCookieCsrf({
        originHeader: undefined,
        secFetchSite: 'same-site',
        allowedOrigins: [PRODUCTION_ORIGIN],
      }),
    ).toEqual({ ok: true });
  });

  it('rejects a cross-site Sec-Fetch-Site when Origin is absent', () => {
    expect(
      assertWebCookieCsrf({
        originHeader: undefined,
        secFetchSite: 'cross-site',
        allowedOrigins: [PRODUCTION_ORIGIN],
      }),
    ).toEqual({ ok: false, reason: 'csrf_missing_or_cross_site' });
  });

  it('rejects when both Origin and Sec-Fetch-Site are absent', () => {
    expect(
      assertWebCookieCsrf({
        originHeader: undefined,
        secFetchSite: undefined,
        allowedOrigins: [PRODUCTION_ORIGIN],
      }),
    ).toEqual({ ok: false, reason: 'csrf_missing_or_cross_site' });
  });

  // Pilot Madrid M8: exact WEBAUTHN_ALLOWED_ORIGINS value confirmed live on
  // town-api-staging (PILOT_MADRID_EVIDENCE.md) -- same list CORS uses,
  // since both are resolved from the same env var by resolveCorsAllowedOrigins.
  it('accepts the Madrid pilot origin under the real three-origin Staging allowlist', () => {
    expect(
      assertWebCookieCsrf({
        originHeader: MADRID_ORIGIN,
        secFetchSite: undefined,
        allowedOrigins: STAGING_ALLOWED_ORIGINS,
      }),
    ).toEqual({ ok: true });
  });

  it('still accepts the pre-existing production and Railway origins under that same allowlist', () => {
    expect(
      assertWebCookieCsrf({
        originHeader: PRODUCTION_ORIGIN,
        secFetchSite: undefined,
        allowedOrigins: STAGING_ALLOWED_ORIGINS,
      }),
    ).toEqual({ ok: true });
    expect(
      assertWebCookieCsrf({
        originHeader: RAILWAY_ORIGIN,
        secFetchSite: undefined,
        allowedOrigins: STAGING_ALLOWED_ORIGINS,
      }),
    ).toEqual({ ok: true });
  });

  it('rejects a lookalike Madrid host even under the real Staging allowlist', () => {
    expect(
      assertWebCookieCsrf({
        originHeader: 'https://evil-madrid-staging.towncivic.org',
        secFetchSite: undefined,
        allowedOrigins: STAGING_ALLOWED_ORIGINS,
      }),
    ).toEqual({ ok: false, reason: 'origin_mismatch' });
  });
});

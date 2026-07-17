/** WebAuthn registration ceremony policy constants (Slice 3). */

export const WEBAUTHN_CHALLENGE_TTL_MINUTES = 5;
export const WEBAUTHN_CHALLENGE_TIMEOUT_MS = WEBAUTHN_CHALLENGE_TTL_MINUTES * 60_000;

export const WEBAUTHN_USER_HANDLE_BYTES = 32;
export const WEBAUTHN_CHALLENGE_HASH_KEY_MIN_LENGTH = 32;

export const SETUP_OPTIONS_GRANT_LIMIT = 5;
export const SETUP_VERIFICATION_GRANT_LIMIT = 5;

export const WEBAUTHN_SUPPORTED_ALGORITHM_IDS = [-7, -257] as const;

export const CIVIC_ACTOR_DISPLAY_LABEL = 'TOWN member';

export const PRODUCTION_RP_ID = 'towncivic.org';
export const PRODUCTION_ALLOWED_ORIGIN = 'https://towncivic.org';

export const DEFAULT_WEBAUTHN_RP_NAME = 'TOWN';

export const FORBIDDEN_PRODUCTION_ORIGIN_HOST_PATTERNS = [
  'www.',
  'api.',
  'railway.app',
  'github.io',
  'pages.dev',
  'vercel.app',
  'netlify.app',
] as const;

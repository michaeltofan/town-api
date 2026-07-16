/** Email verification ceremony policy constants (Slice 2). */
export const EMAIL_VERIFICATION_CODE_LENGTH = 6;
export const EMAIL_VERIFICATION_CODE_TTL_MINUTES = 10;
export const EMAIL_VERIFICATION_MAX_ATTEMPTS = 5;
export const EMAIL_VERIFICATION_DELIVERY_COOLDOWN_SECONDS = 60;

export const EMAIL_VERIFICATION_REQUEST_EMAIL_LIMIT_15M = 3;
export const EMAIL_VERIFICATION_REQUEST_EMAIL_LIMIT_24H = 5;
export const EMAIL_VERIFICATION_REQUEST_IP_LIMIT_15M = 10;
export const EMAIL_VERIFICATION_REQUEST_IP_LIMIT_24H = 50;
export const EMAIL_VERIFICATION_ATTEMPT_EMAIL_IP_LIMIT_30M = 10;

export const EMAIL_VERIFICATION_HASH_KEY_MIN_LENGTH = 32;
export const CEREMONY_RATE_LIMIT_HASH_KEY_MIN_LENGTH = 32;

export const SUPPORTED_LOCALES = ['en', 'it', 'de'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export function isSupportedLocale(value: string): value is SupportedLocale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/** Public password sign-in ceremony policy. */

export const PASSWORD_SIGN_IN_IP_LIMIT_30M = 30;
export const PASSWORD_SIGN_IN_EMAIL_LIMIT_30M = 10;

export const PASSWORD_SIGN_IN_PUBLIC_ERROR_CODE = 'AUTHENTICATION_FAILED' as const;
export const PASSWORD_SIGN_IN_PUBLIC_ERROR_MESSAGE =
  'Authentication could not be completed.' as const;

/** Max UTF-16 length accepted on the public route before Argon2 verification. */
export const PASSWORD_SIGN_IN_PASSWORD_MAX_LENGTH = 256;

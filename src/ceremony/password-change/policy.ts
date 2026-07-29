/** Session-authenticated password-change ceremony policy constants. */

export const PASSWORD_CHANGE_ACCOUNT_LIMIT_30M = 10;

export const PASSWORD_CHANGE_PUBLIC_ERROR_CODE = 'PASSWORD_CHANGE_FAILED' as const;
export const PASSWORD_CHANGE_PUBLIC_ERROR_MESSAGE =
  'Password change could not be completed.' as const;

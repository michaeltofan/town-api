/** Initial password-setup ceremony policy constants. */

export const PASSWORD_SETUP_GRANT_LIMIT = 5;

export const PASSWORD_SETUP_PUBLIC_ERROR_CODE = 'PASSWORD_SETUP_FAILED' as const;
export const PASSWORD_SETUP_PUBLIC_ERROR_MESSAGE =
  'Password setup could not be completed.' as const;

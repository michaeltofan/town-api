import type { Env } from '../../config/env.js';

export type PasswordSetupConfig = {
  enabled: true;
  setupGrantHashKey: string;
  rateLimitHashKey: string;
};

/**
 * Resolve password-setup runtime config. Call only when PASSWORD_AUTH_ENABLED is true.
 * Does not require or apply PASSWORD_HASH_PEPPER — pepper remains reserved/unimplemented.
 */
export function requirePasswordSetupConfig(env: Env): PasswordSetupConfig {
  if (!env.PASSWORD_AUTH_ENABLED) {
    throw new Error('Password setup is not enabled');
  }
  const setupGrantHashKey = env.EMAIL_VERIFICATION_HASH_KEY;
  const rateLimitHashKey = env.CEREMONY_RATE_LIMIT_HASH_KEY;
  if (!setupGrantHashKey || !rateLimitHashKey) {
    throw new Error('Password setup secrets are not configured');
  }
  return {
    enabled: true,
    setupGrantHashKey,
    rateLimitHashKey,
  };
}

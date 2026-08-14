import { createHmac } from 'node:crypto';

export const CAPACITY_ENVIRONMENT_NAME = 'capacity';
export const CAPACITY_DRILL_AUTH_SECRET_MIN_LENGTH = 32;

export function requireCapacityDrillAuthSecret(input: {
  environmentName: string | undefined;
  secret: string | undefined;
}): string {
  if (input.environmentName !== CAPACITY_ENVIRONMENT_NAME) {
    throw new Error(
      `Capacity drill sessions are forbidden outside '${CAPACITY_ENVIRONMENT_NAME}'`,
    );
  }
  if (!input.secret || input.secret.length < CAPACITY_DRILL_AUTH_SECRET_MIN_LENGTH) {
    throw new Error(
      `CAPACITY_DRILL_AUTH_SECRET must contain at least ${String(CAPACITY_DRILL_AUTH_SECRET_MIN_LENGTH)} characters`,
    );
  }
  return input.secret;
}

/**
 * Deterministic opaque token used only by the isolated capacity drill.
 * The raw secret and raw token are never logged or persisted; only the
 * normal account-session token hash is stored in PostgreSQL.
 */
export function deriveCapacityDrillSessionToken(input: {
  secret: string;
  accountId: string;
}): string {
  return createHmac('sha256', input.secret)
    .update('town.capacity_drill_session.v1\0')
    .update(input.accountId)
    .digest('hex');
}

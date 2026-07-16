/**
 * Approved Authentication Ceremony Foundation V1 time-policy constants.
 * RP ID / origin runtime configuration is intentionally out of scope for Slice 1.
 */
export const SETUP_GRANT_TTL_MINUTES = 15;
export const SESSION_IDLE_TIMEOUT_MINUTES = 60;
export const SESSION_ABSOLUTE_TIMEOUT_HOURS = 24;
export const SENSITIVE_REAUTH_FRESHNESS_MINUTES = 10;

export function addMinutes(isoTimestamp: string, minutes: number): string {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) {
    throw new Error('Invalid timestamp');
  }
  date.setUTCMinutes(date.getUTCMinutes() + minutes);
  return date.toISOString();
}

export function addHours(isoTimestamp: string, hours: number): string {
  return addMinutes(isoTimestamp, hours * 60);
}

export function computeAbsoluteExpiresAt(createdAt: string): string {
  return addHours(createdAt, SESSION_ABSOLUTE_TIMEOUT_HOURS);
}

export function computeIdleExpiresAt(from: string, absoluteExpiresAt: string): string {
  const candidate = addMinutes(from, SESSION_IDLE_TIMEOUT_MINUTES);
  return new Date(candidate).getTime() <= new Date(absoluteExpiresAt).getTime()
    ? candidate
    : absoluteExpiresAt;
}

export function computeSetupGrantExpiresAt(createdAt: string): string {
  return addMinutes(createdAt, SETUP_GRANT_TTL_MINUTES);
}

export function isSensitiveOperationFresh(authenticatedAt: string, now: string): boolean {
  const freshestAllowed = addMinutes(authenticatedAt, SENSITIVE_REAUTH_FRESHNESS_MINUTES);
  return new Date(now).getTime() <= new Date(freshestAllowed).getTime();
}

export function isBefore(a: string, b: string): boolean {
  return new Date(a).getTime() < new Date(b).getTime();
}

export function isAtOrBefore(a: string, b: string): boolean {
  return new Date(a).getTime() <= new Date(b).getTime();
}

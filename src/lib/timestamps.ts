/**
 * Normalizes PostgreSQL/Drizzle timestamp strings to canonical ISO-8601 UTC.
 */
export function toIsoTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error('Invalid timestamp value');
  }
  return date.toISOString();
}

import { asc, eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  identitySecurityEvents,
  type IdentitySecurityEventRow,
  type IdentitySecurityEventType,
} from '../../db/schema.js';
import { IdentityInvariantError } from '../errors.js';
import { sanitizeIdentityMetadata } from '../metadata-policy.js';

type Db = Database['db'];

const APPROVED_EVENT_TYPES = new Set<IdentitySecurityEventType>([
  'email_verification_requested',
  'email_verified',
  'passkey_registered',
  'passkey_used',
  'passkey_revoked',
  'recovery_requested',
  'recovery_completed',
  'account_suspended',
  'account_closed',
  'authentication_failed',
  'session_created',
  'session_rotated',
  'session_revoked',
  'counter_anomaly_detected',
  'rate_limit_triggered',
  'passkey_registration_failed',
  'account_activated',
  'authentication_succeeded',
]);

export async function appendIdentitySecurityEvent(
  db: Db,
  input: {
    id: string;
    accountId: string | null;
    eventType: IdentitySecurityEventType;
    occurredAt: string;
    requestId?: string | null;
    metadata?: Record<string, unknown> | null;
  },
): Promise<IdentitySecurityEventRow> {
  if (!APPROVED_EVENT_TYPES.has(input.eventType)) {
    throw new IdentityInvariantError(
      'UNKNOWN_SECURITY_EVENT_TYPE',
      'Unknown identity security event type',
    );
  }

  const metadata = sanitizeIdentityMetadata(input.metadata);

  const rows = await db
    .insert(identitySecurityEvents)
    .values({
      id: input.id,
      accountId: input.accountId,
      eventType: input.eventType,
      occurredAt: input.occurredAt,
      requestId: input.requestId ?? null,
      metadata,
    })
    .returning();
  const row = rows[0];
  if (!row) {
    throw new Error('Failed to append identity security event');
  }
  return row;
}

/** Internal/test-only listing helper. Not a public API. */
export async function listIdentitySecurityEventsForAccount(
  db: Db,
  accountId: string,
): Promise<IdentitySecurityEventRow[]> {
  return db
    .select()
    .from(identitySecurityEvents)
    .where(eq(identitySecurityEvents.accountId, accountId))
    .orderBy(asc(identitySecurityEvents.occurredAt));
}

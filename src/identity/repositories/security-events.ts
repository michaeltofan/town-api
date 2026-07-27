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
  'recovery_email_verified',
  'recovery_registration_failed',
  'passkey_inventory_viewed',
  'passkey_management_changed',
  'passkey_reauthentication_started',
  'passkey_reauthentication_succeeded',
  'passkey_reauthentication_failed',
  'passkey_renamed',
  'membership_created',
  'membership_activated',
  'membership_cancellation_scheduled',
  'membership_reactivated',
  'membership_expired',
  'membership_suspended',
  'membership_restored',
  'membership_paid_pending_binding_provisioned',
  'membership_event_replayed',
  'membership_event_rejected',
  'civic_participation_denied',
  'stripe_checkout_session_created',
  'stripe_customer_linked',
  'stripe_webhook_received',
  'stripe_webhook_verified',
  'stripe_webhook_replayed',
  'stripe_webhook_rejected',
  'stripe_subscription_linked',
  'stripe_invoice_paid',
  'stripe_cancellation_scheduled',
  'stripe_cancellation_removed',
  'stripe_subscription_deleted',
  'stripe_payment_failed',
  'stripe_price_mismatch',
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

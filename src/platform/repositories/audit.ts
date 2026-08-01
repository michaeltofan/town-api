import { and, desc, eq, gte, lte, type SQL } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  platformAuditEvents,
  type PlatformAuditAction,
  type PlatformAuditEventRow,
} from '../../db/schema.js';
import { sanitizeIdentityMetadata } from '../../identity/metadata-policy.js';

type Db = Database['db'];

export async function appendPlatformAuditEvent(
  db: Db,
  input: {
    id: string;
    operatorAccountId: string;
    action: PlatformAuditAction;
    occurredAt: string;
    targetAccountId?: string | null;
    targetSignalId?: string | null;
    requestId?: string | null;
    metadata?: Record<string, unknown> | null;
  },
): Promise<PlatformAuditEventRow> {
  const metadata = sanitizeIdentityMetadata(input.metadata);
  const rows = await db
    .insert(platformAuditEvents)
    .values({
      id: input.id,
      operatorAccountId: input.operatorAccountId,
      action: input.action,
      targetAccountId: input.targetAccountId ?? null,
      targetSignalId: input.targetSignalId ?? null,
      requestId: input.requestId ?? null,
      metadata,
      occurredAt: input.occurredAt,
    })
    .returning();
  const row = rows[0];
  if (!row) {
    throw new Error('Failed to append platform audit event');
  }
  return row;
}

export async function listPlatformAuditEvents(
  db: Db,
  input: {
    limit: number;
    operatorAccountId?: string;
    targetAccountId?: string;
    action?: PlatformAuditAction;
    from?: string;
    to?: string;
  },
): Promise<PlatformAuditEventRow[]> {
  const filters: SQL[] = [];
  if (input.operatorAccountId) {
    filters.push(eq(platformAuditEvents.operatorAccountId, input.operatorAccountId));
  }
  if (input.targetAccountId) {
    filters.push(eq(platformAuditEvents.targetAccountId, input.targetAccountId));
  }
  if (input.action) {
    filters.push(eq(platformAuditEvents.action, input.action));
  }
  if (input.from) {
    filters.push(gte(platformAuditEvents.occurredAt, input.from));
  }
  if (input.to) {
    filters.push(lte(platformAuditEvents.occurredAt, input.to));
  }

  const query = db.select().from(platformAuditEvents);
  const filtered =
    filters.length === 0
      ? query
      : filters.length === 1
        ? query.where(filters[0])
        : query.where(and(...filters));

  return filtered.orderBy(desc(platformAuditEvents.occurredAt)).limit(input.limit);
}

export async function listIdentitySecurityEventsForAccount(
  db: Db,
  input: { accountId: string; limit: number },
): Promise<
  {
    id: string;
    accountId: string | null;
    eventType: string;
    occurredAt: string;
    requestId: string | null;
    metadata: unknown;
  }[]
> {
  const { identitySecurityEvents } = await import('../../db/schema.js');
  return db
    .select({
      id: identitySecurityEvents.id,
      accountId: identitySecurityEvents.accountId,
      eventType: identitySecurityEvents.eventType,
      occurredAt: identitySecurityEvents.occurredAt,
      requestId: identitySecurityEvents.requestId,
      metadata: identitySecurityEvents.metadata,
    })
    .from(identitySecurityEvents)
    .where(eq(identitySecurityEvents.accountId, input.accountId))
    .orderBy(desc(identitySecurityEvents.occurredAt))
    .limit(input.limit);
}

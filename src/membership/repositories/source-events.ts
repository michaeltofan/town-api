import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  membershipSourceEvents,
  type MembershipSource,
  type MembershipSourceEventResult,
  type MembershipSourceEventRow,
  type MembershipSourceEventType,
} from '../../db/schema.js';

type Db = Database['db'];

export async function findSourceEventBySourceAndEventId(
  db: Db,
  source: MembershipSource,
  sourceEventId: string,
): Promise<MembershipSourceEventRow | null> {
  const rows = await db
    .select()
    .from(membershipSourceEvents)
    .where(
      and(
        eq(membershipSourceEvents.source, source),
        eq(membershipSourceEvents.sourceEventId, sourceEventId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function lockSourceEventBySourceAndEventId(
  db: Db,
  source: MembershipSource,
  sourceEventId: string,
): Promise<MembershipSourceEventRow | null> {
  const locked = await db.execute<{
    id: string;
    source: string;
    source_event_id: string;
    event_type: string;
    account_id: string | null;
    payload_hash: string;
    effective_at: string;
    processed_at: string;
    result: string;
    created_at: string;
  }>(sql`
    SELECT id, source, source_event_id, event_type, account_id, payload_hash,
           effective_at, processed_at, result, created_at
    FROM town.membership_source_events
    WHERE source = ${source}
      AND source_event_id = ${sourceEventId}
    FOR UPDATE
  `);
  const row = locked.rows[0];
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    source: row.source,
    sourceEventId: row.source_event_id,
    eventType: row.event_type,
    accountId: row.account_id,
    payloadHash: row.payload_hash,
    effectiveAt: row.effective_at,
    processedAt: row.processed_at,
    result: row.result,
    createdAt: row.created_at,
  };
}

export async function insertMembershipSourceEvent(
  db: Db,
  input: {
    id: string;
    source: MembershipSource;
    sourceEventId: string;
    eventType: MembershipSourceEventType;
    accountId: string;
    payloadHash: string;
    effectiveAt: string;
    processedAt: string;
    result: MembershipSourceEventResult;
    createdAt: string;
  },
): Promise<MembershipSourceEventRow> {
  const rows = await db
    .insert(membershipSourceEvents)
    .values({
      id: input.id,
      source: input.source,
      sourceEventId: input.sourceEventId,
      eventType: input.eventType,
      accountId: input.accountId,
      payloadHash: input.payloadHash,
      effectiveAt: input.effectiveAt,
      processedAt: input.processedAt,
      result: input.result,
      createdAt: input.createdAt,
    })
    .returning();
  const row = rows[0];
  if (!row) {
    throw new Error('Failed to insert membership source event');
  }
  return row;
}

export function isMembershipSourceEventUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  const causeMessage =
    error instanceof Error && error.cause instanceof Error ? error.cause.message : '';
  return /membership_source_events_source_event_unique/i.test(`${message}${causeMessage}`);
}

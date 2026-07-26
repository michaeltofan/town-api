import { and, eq } from 'drizzle-orm';
import type { Database } from '../../../db/client.js';
import { googlePlayRtdnInbox } from '../../../db/schema.js';

export type GooglePlayRtdnInboxRecord = {
  id: string;
  pubsubSubscription: string;
  messageId: string;
  notificationKind: 'subscription' | 'one_time' | 'voided';
  notificationType: number | null;
  purchaseToken: string;
  eventTimeMillis: bigint;
  subscriptionId: string | null;
  rawPayload: Record<string, unknown>;
  payloadHash: string;
  receivedAt: string;
};

export type GooglePlayRtdnInboxResult = 'inserted' | 'replayed' | 'conflict';

export type GooglePlayRtdnInboxPersister = (
  record: GooglePlayRtdnInboxRecord,
) => Promise<GooglePlayRtdnInboxResult>;

export async function persistGooglePlayRtdnInbox(
  db: Database['db'],
  record: GooglePlayRtdnInboxRecord,
): Promise<GooglePlayRtdnInboxResult> {
  const inserted = await db
    .insert(googlePlayRtdnInbox)
    .values(record)
    .onConflictDoNothing({
      target: [googlePlayRtdnInbox.pubsubSubscription, googlePlayRtdnInbox.messageId],
    })
    .returning({ payloadHash: googlePlayRtdnInbox.payloadHash });

  if (inserted.length === 1) {
    return 'inserted';
  }

  const existing = await db
    .select({ payloadHash: googlePlayRtdnInbox.payloadHash })
    .from(googlePlayRtdnInbox)
    .where(
      and(
        eq(googlePlayRtdnInbox.pubsubSubscription, record.pubsubSubscription),
        eq(googlePlayRtdnInbox.messageId, record.messageId),
      ),
    )
    .limit(1);

  if (existing[0]?.payloadHash === record.payloadHash) {
    return 'replayed';
  }
  return 'conflict';
}

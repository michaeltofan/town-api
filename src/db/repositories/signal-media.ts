import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { signalMediaUploads, signals, type SignalMediaUploadRow } from '../schema.js';
import type { MemberSignalMediaContentType } from '../../membership/member-signal-policy.js';

type Db = Database['db'];

export async function insertPendingSignalMediaUpload(
  db: Db,
  input: {
    id: string;
    communityId: string;
    accountId: string;
    actorId: string;
    objectKey: string;
    contentType: MemberSignalMediaContentType;
    byteSize: number;
    createdAt: string;
    expiresAt: string;
  },
): Promise<SignalMediaUploadRow> {
  const rows = await db
    .insert(signalMediaUploads)
    .values({
      id: input.id,
      communityId: input.communityId,
      accountId: input.accountId,
      actorId: input.actorId,
      objectKey: input.objectKey,
      contentType: input.contentType,
      kind: 'image',
      byteSize: input.byteSize,
      status: 'pending',
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
    })
    .returning();
  const row = rows[0];
  if (!row) {
    throw new Error('Signal media upload insert failed');
  }
  return row;
}

export async function findAttachableSignalMediaUpload(
  db: Db,
  input: {
    mediaUploadId: string;
    communityId: string;
    accountId: string;
    now: string;
  },
): Promise<SignalMediaUploadRow | null> {
  const rows = await db
    .select()
    .from(signalMediaUploads)
    .where(
      and(
        eq(signalMediaUploads.id, input.mediaUploadId),
        eq(signalMediaUploads.communityId, input.communityId),
        eq(signalMediaUploads.accountId, input.accountId),
        eq(signalMediaUploads.status, 'pending'),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) {
    return null;
  }
  if (Date.parse(row.expiresAt) <= Date.parse(input.now)) {
    return null;
  }
  return row;
}

export async function markSignalMediaUploadAttached(db: Db, mediaUploadId: string): Promise<void> {
  await db
    .update(signalMediaUploads)
    .set({ status: 'attached' })
    .where(eq(signalMediaUploads.id, mediaUploadId));
}

export async function findSignalMediaUploadById(
  db: Db,
  mediaUploadId: string,
): Promise<SignalMediaUploadRow | null> {
  const rows = await db
    .select()
    .from(signalMediaUploads)
    .where(eq(signalMediaUploads.id, mediaUploadId))
    .limit(1);
  return rows[0] ?? null;
}

export async function countAccountMemberSignalsSince(
  db: Db,
  input: { accountId: string; since: string },
): Promise<number> {
  const rows = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(signals)
    .where(
      and(
        eq(signals.authorAccountId, input.accountId),
        sql`${signals.createdAt} >= ${input.since}`,
      ),
    );
  return rows[0]?.value ?? 0;
}

export async function nextSignalPositionForCommunity(db: Db, communityId: string): Promise<number> {
  const rows = await db
    .select({ value: sql<number>`coalesce(max(${signals.position}), 0)::int` })
    .from(signals)
    .where(eq(signals.communityId, communityId));
  return (rows[0]?.value ?? 0) + 1;
}

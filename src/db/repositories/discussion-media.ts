import { and, eq } from 'drizzle-orm';
import type { Database } from '../client.js';
import {
  signalDiscussionMediaUploads,
  type SignalDiscussionMediaUploadRow,
} from '../schema.js';
import type {
  DiscussionMediaContentType,
  DiscussionMediaKind,
} from '../../membership/discussion-media-policy.js';

type Db = Database['db'];

export async function insertPendingDiscussionMediaUpload(
  db: Db,
  input: {
    id: string;
    signalId: string;
    accountId: string;
    actorId: string;
    objectKey: string;
    contentType: DiscussionMediaContentType;
    kind: DiscussionMediaKind;
    byteSize: number;
    createdAt: string;
    expiresAt: string;
  },
): Promise<SignalDiscussionMediaUploadRow> {
  const rows = await db
    .insert(signalDiscussionMediaUploads)
    .values({
      id: input.id,
      signalId: input.signalId,
      accountId: input.accountId,
      actorId: input.actorId,
      objectKey: input.objectKey,
      contentType: input.contentType,
      kind: input.kind,
      byteSize: input.byteSize,
      status: 'pending',
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
    })
    .returning();
  const row = rows[0];
  if (!row) {
    throw new Error('Discussion media upload insert failed');
  }
  return row;
}

export async function findAttachableDiscussionMediaUpload(
  db: Db,
  input: {
    mediaUploadId: string;
    signalId: string;
    accountId: string;
    now: string;
  },
): Promise<SignalDiscussionMediaUploadRow | null> {
  const rows = await db
    .select()
    .from(signalDiscussionMediaUploads)
    .where(
      and(
        eq(signalDiscussionMediaUploads.id, input.mediaUploadId),
        eq(signalDiscussionMediaUploads.signalId, input.signalId),
        eq(signalDiscussionMediaUploads.accountId, input.accountId),
        eq(signalDiscussionMediaUploads.status, 'pending'),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) {
    return null;
  }
  // Compare as instants — Postgres may return space-separated timestamps.
  if (Date.parse(row.expiresAt) <= Date.parse(input.now)) {
    return null;
  }
  return row;
}

export async function markDiscussionMediaUploadAttached(
  db: Db,
  mediaUploadId: string,
): Promise<void> {
  await db
    .update(signalDiscussionMediaUploads)
    .set({ status: 'attached' })
    .where(eq(signalDiscussionMediaUploads.id, mediaUploadId));
}

export async function findDiscussionMediaUploadById(
  db: Db,
  mediaUploadId: string,
): Promise<SignalDiscussionMediaUploadRow | null> {
  const rows = await db
    .select()
    .from(signalDiscussionMediaUploads)
    .where(eq(signalDiscussionMediaUploads.id, mediaUploadId))
    .limit(1);
  return rows[0] ?? null;
}

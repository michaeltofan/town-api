import { asc, eq } from 'drizzle-orm';
import type { Database } from '../client.js';
import {
  actors,
  signalDiscussionContributions,
  signalDiscussionMediaUploads,
  signalDiscussionSessions,
  type ActorRow,
  type SignalDiscussionContributionRow,
  type SignalDiscussionSessionRow,
} from '../schema.js';
import type { DiscussionMediaKind } from '../../membership/discussion-media-policy.js';

type Db = Database['db'];

export type DiscussionContributionIntent = 'observation' | 'proposal' | 'next_step';

export type DiscussionContributionMediaView = {
  kind: DiscussionMediaKind;
  contentType: string;
  byteSize: number;
};

export type DiscussionContributionView = {
  id: string;
  authorDisplayName: string;
  text: string;
  intent: DiscussionContributionIntent;
  createdAt: string;
  media: DiscussionContributionMediaView | null;
};

export async function findDiscussionSessionBySignalId(
  db: Db,
  signalId: string,
): Promise<SignalDiscussionSessionRow | null> {
  const rows = await db
    .select()
    .from(signalDiscussionSessions)
    .where(eq(signalDiscussionSessions.signalId, signalId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Idempotently ensures one discussion session exists per signal.
 * Concurrent creates collide on signal_id unique and re-read the winner.
 */
export async function ensureDiscussionSessionForSignal(
  db: Db,
  input: { signalId: string; id: string; now: string },
): Promise<SignalDiscussionSessionRow> {
  await db
    .insert(signalDiscussionSessions)
    .values({
      id: input.id,
      signalId: input.signalId,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .onConflictDoNothing({
      target: [signalDiscussionSessions.signalId],
    });

  const existing = await findDiscussionSessionBySignalId(db, input.signalId);
  if (!existing) {
    throw new Error('Discussion session create failed');
  }
  return existing;
}

export async function listDiscussionContributionsForSession(
  db: Db,
  sessionId: string,
): Promise<DiscussionContributionView[]> {
  const rows = await db
    .select({
      id: signalDiscussionContributions.id,
      text: signalDiscussionContributions.text,
      intent: signalDiscussionContributions.intent,
      createdAt: signalDiscussionContributions.createdAt,
      authorDisplayName: actors.displayLabel,
      mediaKind: signalDiscussionMediaUploads.kind,
      mediaContentType: signalDiscussionMediaUploads.contentType,
      mediaByteSize: signalDiscussionMediaUploads.byteSize,
      mediaStatus: signalDiscussionMediaUploads.status,
    })
    .from(signalDiscussionContributions)
    .innerJoin(actors, eq(actors.id, signalDiscussionContributions.actorId))
    .leftJoin(
      signalDiscussionMediaUploads,
      eq(signalDiscussionMediaUploads.id, signalDiscussionContributions.mediaUploadId),
    )
    .where(eq(signalDiscussionContributions.sessionId, sessionId))
    .orderBy(asc(signalDiscussionContributions.createdAt));

  return rows.map((row) => ({
    id: row.id,
    authorDisplayName: row.authorDisplayName,
    text: row.text,
    intent: row.intent as DiscussionContributionIntent,
    createdAt: row.createdAt,
    media:
      row.mediaStatus === 'attached' &&
      row.mediaKind &&
      row.mediaContentType &&
      typeof row.mediaByteSize === 'number'
        ? {
            kind: row.mediaKind as DiscussionMediaKind,
            contentType: row.mediaContentType,
            byteSize: row.mediaByteSize,
          }
        : null,
  }));
}

export async function insertDiscussionContribution(
  db: Db,
  input: {
    id: string;
    sessionId: string;
    signalId: string;
    actorId: string;
    text: string;
    intent: DiscussionContributionIntent;
    mediaUploadId?: string | null;
    createdAt: string;
  },
): Promise<SignalDiscussionContributionRow> {
  const rows = await db
    .insert(signalDiscussionContributions)
    .values({
      id: input.id,
      sessionId: input.sessionId,
      signalId: input.signalId,
      actorId: input.actorId,
      text: input.text,
      intent: input.intent,
      mediaUploadId: input.mediaUploadId ?? null,
      createdAt: input.createdAt,
    })
    .returning();

  const row = rows[0];
  if (!row) {
    throw new Error('Discussion contribution insert failed');
  }

  await db
    .update(signalDiscussionSessions)
    .set({ updatedAt: input.createdAt })
    .where(eq(signalDiscussionSessions.id, input.sessionId));

  return row;
}

export async function findDiscussionContributionForSignal(
  db: Db,
  signalId: string,
  contributionId: string,
): Promise<{
  contributionId: string;
  mediaUploadId: string | null;
} | null> {
  const rows = await db
    .select({
      contributionId: signalDiscussionContributions.id,
      mediaUploadId: signalDiscussionContributions.mediaUploadId,
      signalId: signalDiscussionContributions.signalId,
    })
    .from(signalDiscussionContributions)
    .where(eq(signalDiscussionContributions.id, contributionId))
    .limit(1);
  const row = rows[0];
  if (!row || row.signalId !== signalId) {
    return null;
  }
  return {
    contributionId: row.contributionId,
    mediaUploadId: row.mediaUploadId,
  };
}

export type { ActorRow };

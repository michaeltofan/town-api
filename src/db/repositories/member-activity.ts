import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { Database } from '../client.js';
import {
  communities,
  signalConfirmations,
  signalDiscussionContributions,
  signals,
} from '../schema.js';

type Db = Database['db'];

export type MemberActivitySignalRef = {
  id: string;
  slug: string;
  headline: string;
  statusLabel: string;
  statusNote: string;
  latestUpdate: string;
  publishedAt: string;
  updatedAt: string;
  community: {
    id: string;
    slug: string;
    displayName: string;
  };
};

export type MemberActivityConfirmationRow = {
  confirmedAt: string;
  signal: MemberActivitySignalRef;
};

export type MemberActivityContributionRow = {
  id: string;
  text: string;
  intent: 'observation' | 'proposal' | 'next_step';
  createdAt: string;
  signal: MemberActivitySignalRef;
};

export type MemberActivityAuthoredSignalRow = {
  publishedAt: string;
  signal: MemberActivitySignalRef;
};

function toSignalRef(row: {
  signalId: string;
  signalSlug: string;
  headline: string;
  statusLabel: string;
  statusNote: string;
  latestUpdate: string;
  publishedAt: string;
  updatedAt: string;
  communityId: string;
  communitySlug: string;
  communityDisplayName: string;
}): MemberActivitySignalRef {
  return {
    id: row.signalId,
    slug: row.signalSlug,
    headline: row.headline,
    statusLabel: row.statusLabel,
    statusNote: row.statusNote,
    latestUpdate: row.latestUpdate,
    publishedAt: row.publishedAt,
    updatedAt: row.updatedAt,
    community: {
      id: row.communityId,
      slug: row.communitySlug,
      displayName: row.communityDisplayName,
    },
  };
}

const visiblePublished = and(eq(signals.publicationStatus, 'published'), isNull(signals.hiddenAt));

/**
 * Self-only confirmations for a civic actor, newest first.
 * Hidden signals are excluded (same visibility as public feed).
 */
export async function listConfirmationsForActorActivity(
  db: Db,
  actorId: string,
  limit: number,
): Promise<MemberActivityConfirmationRow[]> {
  const rows = await db
    .select({
      confirmedAt: signalConfirmations.confirmedAt,
      signalId: signals.id,
      signalSlug: signals.slug,
      headline: signals.headline,
      statusLabel: signals.statusLabel,
      statusNote: signals.statusNote,
      latestUpdate: signals.latestUpdate,
      publishedAt: signals.publishedAt,
      updatedAt: signals.updatedAt,
      communityId: communities.id,
      communitySlug: communities.slug,
      communityDisplayName: communities.displayName,
    })
    .from(signalConfirmations)
    .innerJoin(signals, eq(signals.id, signalConfirmations.signalId))
    .innerJoin(communities, eq(communities.id, signals.communityId))
    .where(and(eq(signalConfirmations.actorId, actorId), visiblePublished))
    .orderBy(desc(signalConfirmations.confirmedAt))
    .limit(limit);

  return rows.map((row) => ({
    confirmedAt: row.confirmedAt,
    signal: toSignalRef(row),
  }));
}

/**
 * Self-only published discussion contributions for a civic actor, newest first.
 */
export async function listContributionsForActorActivity(
  db: Db,
  actorId: string,
  limit: number,
): Promise<MemberActivityContributionRow[]> {
  const rows = await db
    .select({
      id: signalDiscussionContributions.id,
      text: signalDiscussionContributions.text,
      intent: signalDiscussionContributions.intent,
      createdAt: signalDiscussionContributions.createdAt,
      signalId: signals.id,
      signalSlug: signals.slug,
      headline: signals.headline,
      statusLabel: signals.statusLabel,
      statusNote: signals.statusNote,
      latestUpdate: signals.latestUpdate,
      publishedAt: signals.publishedAt,
      updatedAt: signals.updatedAt,
      communityId: communities.id,
      communitySlug: communities.slug,
      communityDisplayName: communities.displayName,
    })
    .from(signalDiscussionContributions)
    .innerJoin(signals, eq(signals.id, signalDiscussionContributions.signalId))
    .innerJoin(communities, eq(communities.id, signals.communityId))
    .where(and(eq(signalDiscussionContributions.actorId, actorId), visiblePublished))
    .orderBy(desc(signalDiscussionContributions.createdAt))
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    text: row.text,
    intent: row.intent as MemberActivityContributionRow['intent'],
    createdAt: row.createdAt,
    signal: toSignalRef(row),
  }));
}

/**
 * Signals authored by this account (member publish), newest first.
 */
export async function listAuthoredSignalsForAccountActivity(
  db: Db,
  accountId: string,
  limit: number,
): Promise<MemberActivityAuthoredSignalRow[]> {
  const rows = await db
    .select({
      signalId: signals.id,
      signalSlug: signals.slug,
      headline: signals.headline,
      statusLabel: signals.statusLabel,
      statusNote: signals.statusNote,
      latestUpdate: signals.latestUpdate,
      publishedAt: signals.publishedAt,
      updatedAt: signals.updatedAt,
      communityId: communities.id,
      communitySlug: communities.slug,
      communityDisplayName: communities.displayName,
    })
    .from(signals)
    .innerJoin(communities, eq(communities.id, signals.communityId))
    .where(and(eq(signals.authorAccountId, accountId), visiblePublished))
    .orderBy(desc(signals.publishedAt))
    .limit(limit);

  return rows.map((row) => ({
    publishedAt: row.publishedAt,
    signal: toSignalRef(row),
  }));
}

/**
 * Visible published signals the member participates in (confirmed, contributed, or authored).
 * Used for evolution rows (status / latest update), not invented timeline events.
 */
export async function listParticipatedSignalsForActorActivity(
  db: Db,
  input: { actorId: string; accountId: string; limit: number },
): Promise<MemberActivitySignalRef[]> {
  const [confirmedIds, contributionIds, authoredIds] = await Promise.all([
    db
      .select({ signalId: signalConfirmations.signalId })
      .from(signalConfirmations)
      .where(eq(signalConfirmations.actorId, input.actorId)),
    db
      .select({ signalId: signalDiscussionContributions.signalId })
      .from(signalDiscussionContributions)
      .where(eq(signalDiscussionContributions.actorId, input.actorId)),
    db
      .select({ signalId: signals.id })
      .from(signals)
      .where(and(eq(signals.authorAccountId, input.accountId), visiblePublished)),
  ]);

  const idSet = new Set<string>();
  for (const row of confirmedIds) idSet.add(row.signalId);
  for (const row of contributionIds) idSet.add(row.signalId);
  for (const row of authoredIds) idSet.add(row.signalId);

  const ids = [...idSet];
  if (ids.length === 0) {
    return [];
  }

  const rows = await db
    .select({
      signalId: signals.id,
      signalSlug: signals.slug,
      headline: signals.headline,
      statusLabel: signals.statusLabel,
      statusNote: signals.statusNote,
      latestUpdate: signals.latestUpdate,
      publishedAt: signals.publishedAt,
      updatedAt: signals.updatedAt,
      communityId: communities.id,
      communitySlug: communities.slug,
      communityDisplayName: communities.displayName,
    })
    .from(signals)
    .innerJoin(communities, eq(communities.id, signals.communityId))
    .where(and(inArray(signals.id, ids), visiblePublished))
    .orderBy(desc(signals.updatedAt))
    .limit(input.limit);

  return rows.map((row) => toSignalRef(row));
}

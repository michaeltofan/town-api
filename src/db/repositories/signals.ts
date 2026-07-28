import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Database } from '../client.js';
import {
  communities,
  signals,
  type CommunityRow,
  type SignalHideReason,
  type SignalRow,
} from '../schema.js';

type Db = Database['db'];

export type SignalWithCommunity = {
  signal: SignalRow;
  community: Pick<CommunityRow, 'id' | 'slug' | 'displayName' | 'defaultLocale'>;
};

export async function listPublishedSignalsForCommunity(
  db: Db,
  communityId: string,
): Promise<SignalRow[]> {
  return db
    .select()
    .from(signals)
    .where(
      and(
        eq(signals.communityId, communityId),
        eq(signals.publicationStatus, 'published'),
        isNull(signals.hiddenAt),
      ),
    )
    .orderBy(asc(signals.position));
}

export async function findPublishedSignalById(
  db: Db,
  signalId: string,
): Promise<SignalWithCommunity | null> {
  const rows = await db
    .select({
      signal: signals,
      communityId: communities.id,
      communitySlug: communities.slug,
      communityDisplayName: communities.displayName,
      communityDefaultLocale: communities.defaultLocale,
    })
    .from(signals)
    .innerJoin(communities, eq(signals.communityId, communities.id))
    .where(
      and(
        eq(signals.id, signalId),
        eq(signals.publicationStatus, 'published'),
        isNull(signals.hiddenAt),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) {
    return null;
  }

  return {
    signal: row.signal,
    community: {
      id: row.communityId,
      slug: row.communitySlug,
      displayName: row.communityDisplayName,
      defaultLocale: row.communityDefaultLocale,
    },
  };
}

/** Lock signal row for owner moderation. Returns null when the id does not exist. */
export async function lockSignalById(db: Db, signalId: string): Promise<SignalRow | null> {
  const rows = await db
    .select()
    .from(signals)
    .where(eq(signals.id, signalId))
    .limit(1)
    .for('update');
  return rows[0] ?? null;
}

export type HideSignalResult = {
  signal: SignalRow;
  changed: boolean;
};

/**
 * Hide a signal. Idempotent: if already hidden, leaves who/when/why untouched and
 * reports changed=false (no overwrite).
 */
export async function hideSignal(
  db: Db,
  input: {
    signalId: string;
    reason: SignalHideReason;
    hiddenByAccountId: string;
    at: string;
  },
): Promise<HideSignalResult | null> {
  const locked = await lockSignalById(db, input.signalId);
  if (!locked) {
    return null;
  }

  if (locked.hiddenAt !== null) {
    return { signal: locked, changed: false };
  }

  const rows = await db
    .update(signals)
    .set({
      hiddenAt: input.at,
      hiddenReason: input.reason,
      hiddenByAccountId: input.hiddenByAccountId,
      updatedAt: input.at,
    })
    .where(eq(signals.id, input.signalId))
    .returning();

  const signal = rows[0];
  if (!signal) {
    throw new Error('Failed to hide signal');
  }
  return { signal, changed: true };
}

/**
 * Un-hide a signal. Idempotent: if already visible, reports changed=false.
 */
export async function unhideSignal(
  db: Db,
  input: {
    signalId: string;
    at: string;
  },
): Promise<HideSignalResult | null> {
  const locked = await lockSignalById(db, input.signalId);
  if (!locked) {
    return null;
  }

  if (locked.hiddenAt === null) {
    return { signal: locked, changed: false };
  }

  const rows = await db
    .update(signals)
    .set({
      hiddenAt: null,
      hiddenReason: null,
      hiddenByAccountId: null,
      updatedAt: input.at,
    })
    .where(eq(signals.id, input.signalId))
    .returning();

  const signal = rows[0];
  if (!signal) {
    throw new Error('Failed to unhide signal');
  }
  return { signal, changed: true };
}

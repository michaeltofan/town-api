import { and, asc, eq } from 'drizzle-orm';
import type { Database } from '../client.js';
import { communities, signals, type CommunityRow, type SignalRow } from '../schema.js';

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
    .where(and(eq(signals.communityId, communityId), eq(signals.publicationStatus, 'published')))
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
    .where(and(eq(signals.id, signalId), eq(signals.publicationStatus, 'published')))
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

import { and, asc, eq } from 'drizzle-orm';
import type { Database } from '../client.js';
import { communities, type CommunityRow } from '../schema.js';

type Db = Database['db'];

export async function listActiveCommunities(db: Db): Promise<CommunityRow[]> {
  return db
    .select()
    .from(communities)
    .where(eq(communities.status, 'active'))
    .orderBy(asc(communities.position));
}

export async function findActiveCommunityBySlug(
  db: Db,
  slug: string,
): Promise<CommunityRow | null> {
  const rows = await db
    .select()
    .from(communities)
    .where(and(eq(communities.status, 'active'), eq(communities.slug, slug)))
    .limit(1);

  return rows[0] ?? null;
}

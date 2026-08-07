import { sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import type { PublicCivicProcessStage } from './civic-processes.js';

type Db = Database['db'];

export type CivicInboxProcessRow = {
  processId: string;
  signalId: string;
  signalSlug: string;
  headline: string;
  communitySlug: string;
  communityDisplayName: string;
  currentStage: PublicCivicProcessStage;
  updatedAt: string;
  isNew: boolean;
};

function isSupportedStage(value: string): value is PublicCivicProcessStage {
  return (
    value === 'confirmation' ||
    value === 'proposals' ||
    value === 'deliberation' ||
    value === 'ballot_preparation' ||
    value === 'voting' ||
    value === 'mandate' ||
    value === 'action' ||
    value === 'verification' ||
    value === 'archived'
  );
}

/**
 * Every visible, published civic process this actor has recorded a
 * participation row in — confirmed, proposed, deliberated, voted, posted an
 * action update, submitted verification evidence, or confirmed a
 * verification outcome. Not a general community feed: only processes the
 * actor actually touched.
 */
export async function listCivicInboxProcessesForActor(
  db: Db,
  actorId: string,
  limit = 50,
): Promise<CivicInboxProcessRow[]> {
  const boundedLimit = Math.max(1, Math.min(limit, 50));
  const result = await db.execute<{
    process_id: string;
    signal_id: string;
    signal_slug: string;
    headline: string;
    community_slug: string;
    community_display_name: string;
    current_stage: string;
    updated_at: string;
    viewed_at: string | null;
  }>(sql`
    WITH participated AS (
      SELECT process_id FROM town.civic_proposals WHERE author_actor_id = ${actorId}
      UNION
      SELECT process_id FROM town.civic_deliberation_contributions WHERE author_actor_id = ${actorId}
      UNION
      -- civic_votes carries no actor link (§9, secret ballot) — "did this
      -- actor vote on this process" is derived from token consumption
      -- instead, never from the anonymized vote content itself.
      SELECT process_id FROM town.civic_ballot_tokens
      WHERE actor_id = ${actorId} AND consumed_at IS NOT NULL
      UNION
      SELECT process_id FROM town.civic_action_updates WHERE author_actor_id = ${actorId}
      UNION
      SELECT process_id FROM town.civic_verification_evidence WHERE author_actor_id = ${actorId}
      UNION
      SELECT process_id FROM town.civic_verification_confirmations WHERE actor_id = ${actorId}
      UNION
      SELECT process.id AS process_id
      FROM town.signal_confirmations confirmation
      JOIN town.civic_processes process ON process.signal_id = confirmation.signal_id
      WHERE confirmation.actor_id = ${actorId}
    )
    SELECT
      process.id AS process_id,
      process.signal_id,
      signal.slug AS signal_slug,
      signal.headline,
      community.slug AS community_slug,
      community.display_name AS community_display_name,
      process.current_stage,
      process.updated_at,
      view.viewed_at
    FROM participated
    JOIN town.civic_processes process ON process.id = participated.process_id
    JOIN town.signals signal ON signal.id = process.signal_id
    JOIN town.communities community ON community.id = signal.community_id
    LEFT JOIN town.civic_process_views view
      ON view.process_id = process.id AND view.actor_id = ${actorId}
    WHERE signal.publication_status = 'published' AND signal.hidden_at IS NULL
    ORDER BY process.updated_at DESC
    LIMIT ${boundedLimit}
  `);
  return result.rows.map((row) => {
    if (!isSupportedStage(row.current_stage)) {
      throw new Error('Unsupported civic process stage');
    }
    return {
      processId: row.process_id,
      signalId: row.signal_id,
      signalSlug: row.signal_slug,
      headline: row.headline,
      communitySlug: row.community_slug,
      communityDisplayName: row.community_display_name,
      currentStage: row.current_stage,
      updatedAt: row.updated_at,
      isNew:
        !row.viewed_at || new Date(row.viewed_at).getTime() < new Date(row.updated_at).getTime(),
    };
  });
}

export async function markCivicProcessViewed(
  db: Db,
  input: { id: string; actorId: string; processId: string; viewedAt: string },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO town.civic_process_views (id, actor_id, process_id, viewed_at)
    VALUES (${input.id}, ${input.actorId}, ${input.processId}, ${input.viewedAt})
    ON CONFLICT (actor_id, process_id) DO UPDATE SET viewed_at = ${input.viewedAt}
  `);
}

import { sql } from 'drizzle-orm';
import type { Database } from '../client.js';

type Db = Database['db'];

export type CivicDeliberationContributionView = {
  id: string;
  processId: string;
  proposalId: string;
  authorActorId: string;
  authorDisplayName: string;
  intent: 'observation' | 'proposal' | 'next_step';
  text: string;
  createdAt: string;
};

function toContributionView(row: {
  id: string;
  process_id: string;
  proposal_id: string;
  author_actor_id: string;
  author_display_name: string;
  intent: string;
  text: string;
  created_at: string;
}): CivicDeliberationContributionView {
  if (row.intent !== 'observation' && row.intent !== 'proposal' && row.intent !== 'next_step') {
    throw new Error('Unsupported civic deliberation contribution intent');
  }
  return {
    id: row.id,
    processId: row.process_id,
    proposalId: row.proposal_id,
    authorActorId: row.author_actor_id,
    authorDisplayName: row.author_display_name,
    intent: row.intent,
    text: row.text,
    createdAt: row.created_at,
  };
}

export async function listCivicDeliberationContributionsForProcess(
  db: Db,
  processId: string,
  limit = 200,
): Promise<CivicDeliberationContributionView[]> {
  const boundedLimit = Math.max(1, Math.min(limit, 200));
  const result = await db.execute<{
    id: string;
    process_id: string;
    proposal_id: string;
    author_actor_id: string;
    author_display_name: string;
    intent: string;
    text: string;
    created_at: string;
  }>(sql`
    SELECT
      contribution.id,
      contribution.process_id,
      contribution.proposal_id,
      contribution.author_actor_id,
      actor.display_label AS author_display_name,
      contribution.intent,
      contribution.text,
      contribution.created_at
    FROM town.civic_deliberation_contributions contribution
    JOIN town.actors actor ON actor.id = contribution.author_actor_id
    WHERE contribution.process_id = ${processId}
    ORDER BY contribution.created_at ASC, contribution.id ASC
    LIMIT ${boundedLimit}
  `);
  return result.rows.map(toContributionView);
}

export async function insertCivicDeliberationContribution(
  db: Db,
  input: {
    id: string;
    processId: string;
    proposalId: string;
    actorId: string;
    intent: 'observation' | 'proposal' | 'next_step';
    text: string;
    createdAt: string;
  },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO town.civic_deliberation_contributions (
      id, process_id, proposal_id, author_actor_id, intent, text, created_at
    ) VALUES (
      ${input.id}, ${input.processId}, ${input.proposalId}, ${input.actorId},
      ${input.intent}, ${input.text}, ${input.createdAt}
    )
  `);
}

export async function countDistinctCivicDeliberationParticipants(
  db: Db,
  processId: string,
): Promise<number> {
  const result = await db.execute<{ count: string }>(sql`
    SELECT count(DISTINCT author_actor_id)::text AS count
    FROM town.civic_deliberation_contributions
    WHERE process_id = ${processId}
  `);
  return Number(result.rows[0]?.count ?? 0);
}

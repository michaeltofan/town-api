import { sql } from 'drizzle-orm';
import type { Database } from '../client.js';

type Db = Database['db'];

export type CivicProposalView = {
  id: string;
  processId: string;
  authorActorId: string;
  authorDisplayName: string;
  title: string;
  body: string;
  createdAt: string;
};

export async function listCivicProposals(
  db: Db,
  processId: string,
  limit = 100,
): Promise<CivicProposalView[]> {
  const boundedLimit = Math.max(1, Math.min(limit, 100));
  const result = await db.execute<{
    id: string;
    process_id: string;
    author_actor_id: string;
    author_display_name: string;
    title: string;
    body: string;
    created_at: string;
  }>(sql`
    SELECT
      proposal.id,
      proposal.process_id,
      proposal.author_actor_id,
      actor.display_label AS author_display_name,
      proposal.title,
      proposal.body,
      proposal.created_at
    FROM town.civic_proposals proposal
    JOIN town.actors actor ON actor.id = proposal.author_actor_id
    WHERE proposal.process_id = ${processId}
    ORDER BY proposal.created_at ASC, proposal.id ASC
    LIMIT ${boundedLimit}
  `);
  return result.rows.map((row) => ({
    id: row.id,
    processId: row.process_id,
    authorActorId: row.author_actor_id,
    authorDisplayName: row.author_display_name,
    title: row.title,
    body: row.body,
    createdAt: row.created_at,
  }));
}

export async function findCivicProposalByProcessAndActor(
  db: Db,
  input: { processId: string; actorId: string },
): Promise<CivicProposalView | null> {
  const proposals = await db.execute<{
    id: string;
    process_id: string;
    author_actor_id: string;
    author_display_name: string;
    title: string;
    body: string;
    created_at: string;
  }>(sql`
    SELECT
      proposal.id,
      proposal.process_id,
      proposal.author_actor_id,
      actor.display_label AS author_display_name,
      proposal.title,
      proposal.body,
      proposal.created_at
    FROM town.civic_proposals proposal
    JOIN town.actors actor ON actor.id = proposal.author_actor_id
    WHERE proposal.process_id = ${input.processId}
      AND proposal.author_actor_id = ${input.actorId}
    LIMIT 1
  `);
  const row = proposals.rows[0];
  return row
    ? {
        id: row.id,
        processId: row.process_id,
        authorActorId: row.author_actor_id,
        authorDisplayName: row.author_display_name,
        title: row.title,
        body: row.body,
        createdAt: row.created_at,
      }
    : null;
}

export async function insertCivicProposal(
  db: Db,
  input: {
    id: string;
    processId: string;
    actorId: string;
    title: string;
    body: string;
    createdAt: string;
  },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO town.civic_proposals (
      id, process_id, author_actor_id, title, body, created_at
    ) VALUES (
      ${input.id}, ${input.processId}, ${input.actorId},
      ${input.title}, ${input.body}, ${input.createdAt}
    )
  `);
}

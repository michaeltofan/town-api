import { sql } from 'drizzle-orm';
import type { Database } from '../client.js';

type Db = Database['db'];

export type CivicVoteTallyRow = {
  proposalId: string;
  voteCount: number;
};

export async function findCivicVoteByProcessAndActor(
  db: Db,
  input: { processId: string; actorId: string },
): Promise<{ proposalId: string } | null> {
  const result = await db.execute<{ proposal_id: string }>(sql`
    SELECT proposal_id
    FROM town.civic_votes
    WHERE process_id = ${input.processId}
      AND actor_id = ${input.actorId}
    LIMIT 1
  `);
  const row = result.rows[0];
  return row ? { proposalId: row.proposal_id } : null;
}

export async function listCivicVoteTallyForProcess(
  db: Db,
  processId: string,
): Promise<CivicVoteTallyRow[]> {
  const result = await db.execute<{ proposal_id: string; vote_count: string }>(sql`
    SELECT proposal_id, count(*)::text AS vote_count
    FROM town.civic_votes
    WHERE process_id = ${processId}
    GROUP BY proposal_id
  `);
  return result.rows.map((row) => ({
    proposalId: row.proposal_id,
    voteCount: Number(row.vote_count),
  }));
}

export async function countCivicVotesForProcess(db: Db, processId: string): Promise<number> {
  const result = await db.execute<{ count: string }>(sql`
    SELECT count(*)::text AS count
    FROM town.civic_votes
    WHERE process_id = ${processId}
  `);
  return Number(result.rows[0]?.count ?? 0);
}

export async function insertCivicVote(
  db: Db,
  input: { id: string; processId: string; proposalId: string; actorId: string; castAt: string },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO town.civic_votes (id, process_id, proposal_id, actor_id, cast_at)
    VALUES (${input.id}, ${input.processId}, ${input.proposalId}, ${input.actorId}, ${input.castAt})
  `);
}

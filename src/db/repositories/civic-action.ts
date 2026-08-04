import { sql } from 'drizzle-orm';
import type { Database } from '../client.js';

type Db = Database['db'];

export type CivicActionUpdateRow = {
  id: string;
  processId: string;
  authorActorId: string;
  authorDisplayName: string;
  text: string;
  createdAt: string;
};

export async function insertCivicActionUpdate(
  db: Db,
  input: { id: string; processId: string; actorId: string; text: string; createdAt: string },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO town.civic_action_updates (id, process_id, author_actor_id, text, created_at)
    VALUES (${input.id}, ${input.processId}, ${input.actorId}, ${input.text}, ${input.createdAt})
  `);
}

export async function listCivicActionUpdatesForProcess(
  db: Db,
  processId: string,
  limit = 200,
): Promise<CivicActionUpdateRow[]> {
  const boundedLimit = Math.max(1, Math.min(limit, 200));
  const result = await db.execute<{
    id: string;
    process_id: string;
    author_actor_id: string;
    author_display_name: string;
    text: string;
    created_at: string;
  }>(sql`
    SELECT
      update.id,
      update.process_id,
      update.author_actor_id,
      actor.display_label AS author_display_name,
      update.text,
      update.created_at
    FROM town.civic_action_updates update
    JOIN town.actors actor ON actor.id = update.author_actor_id
    WHERE update.process_id = ${processId}
    ORDER BY update.created_at, update.id
    LIMIT ${boundedLimit}
  `);
  return result.rows.map((row) => ({
    id: row.id,
    processId: row.process_id,
    authorActorId: row.author_actor_id,
    authorDisplayName: row.author_display_name,
    text: row.text,
    createdAt: row.created_at,
  }));
}

import { sql } from 'drizzle-orm';
import type { Database } from '../client.js';

type Db = Database['db'];

export async function countCivicBallotEligibleActors(db: Db, processId: string): Promise<number> {
  const result = await db.execute<{ count: string }>(sql`
    SELECT count(*)::text AS count
    FROM town.civic_ballot_eligible_actors
    WHERE process_id = ${processId}
  `);
  return Number(result.rows[0]?.count ?? 0);
}

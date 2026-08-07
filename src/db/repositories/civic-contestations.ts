import { sql } from 'drizzle-orm';
import type { Database } from '../client.js';

type Db = Database['db'];

export type CivicContestationReasonKey =
  'eligibility_error' | 'ballot_tampering_suspected' | 'count_discrepancy';

export type CivicContestationStatus = 'pending' | 'upheld' | 'rejected';

export type CivicMandateContestationView = {
  id: string;
  processId: string;
  reasonKey: CivicContestationReasonKey;
  elaboration: string | null;
  status: CivicContestationStatus;
  filedAt: string;
};

const SUPPORTED_REASON_KEYS: readonly CivicContestationReasonKey[] = [
  'eligibility_error',
  'ballot_tampering_suspected',
  'count_discrepancy',
];

function toReasonKey(value: string): CivicContestationReasonKey {
  if (!(SUPPORTED_REASON_KEYS as readonly string[]).includes(value)) {
    throw new Error('Unsupported civic mandate contestation reason key');
  }
  return value as CivicContestationReasonKey;
}

function toStatus(value: string): CivicContestationStatus {
  if (value !== 'pending' && value !== 'upheld' && value !== 'rejected') {
    throw new Error('Unsupported civic mandate contestation status');
  }
  return value;
}

function toView(row: {
  id: string;
  process_id: string;
  reason_key: string;
  elaboration: string | null;
  status: string;
  filed_at: string;
}): CivicMandateContestationView {
  return {
    id: row.id,
    processId: row.process_id,
    reasonKey: toReasonKey(row.reason_key),
    elaboration: row.elaboration,
    status: toStatus(row.status),
    filedAt: row.filed_at,
  };
}

export async function findCivicMandateContestationByProcessAndActor(
  db: Db,
  input: { processId: string; actorId: string },
): Promise<CivicMandateContestationView | null> {
  const result = await db.execute<{
    id: string;
    process_id: string;
    reason_key: string;
    elaboration: string | null;
    status: string;
    filed_at: string;
  }>(sql`
    SELECT id, process_id, reason_key, elaboration, status, filed_at
    FROM town.civic_mandate_contestations
    WHERE process_id = ${input.processId} AND filer_actor_id = ${input.actorId}
    LIMIT 1
  `);
  const row = result.rows[0];
  return row ? toView(row) : null;
}

export async function hasPendingCivicMandateContestation(
  db: Db,
  processId: string,
): Promise<boolean> {
  const result = await db.execute<{ exists: boolean }>(sql`
    SELECT EXISTS(
      SELECT 1 FROM town.civic_mandate_contestations
      WHERE process_id = ${processId} AND status = 'pending'
    ) AS exists
  `);
  return result.rows[0]?.exists ?? false;
}

export async function insertCivicMandateContestation(
  db: Db,
  input: {
    processId: string;
    filerActorId: string;
    reasonKey: CivicContestationReasonKey;
    elaboration: string | null;
    filedAt: string;
  },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO town.civic_mandate_contestations (
      id, process_id, filer_actor_id, reason_key, elaboration, filed_at
    ) VALUES (
      gen_random_uuid(), ${input.processId}, ${input.filerActorId}, ${input.reasonKey},
      ${input.elaboration}, ${input.filedAt}
    )
  `);
}

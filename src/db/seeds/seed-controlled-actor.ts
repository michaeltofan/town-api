import type { Database } from '../client.js';
import { actors, type ActorRow } from '../schema.js';
import {
  CONTROLLED_TEST_ACTOR,
  type CanonicalControlledActor,
} from './controlled-actor-content.js';

type Db = Database['db'];

function toActorInsert(row: CanonicalControlledActor): ActorRow {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    displayLabel: row.displayLabel,
    communityId: row.communityId,
    accountId: null,
    localEligibilityVerifiedAt: null,
    communityCommitmentAcceptedAt: null,
    communityCommitmentVersion: null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Upserts the single canonical controlled test actor using a fixed ID.
 * Does not create confirmation rows. Does not truncate or delete unknown records.
 * Does not modify communities or signals.
 */
export async function seedControlledActor(db: Db): Promise<void> {
  const values = toActorInsert(CONTROLLED_TEST_ACTOR);
  await db
    .insert(actors)
    .values(values)
    .onConflictDoUpdate({
      target: actors.id,
      set: {
        kind: values.kind,
        status: values.status,
        displayLabel: values.displayLabel,
        communityId: values.communityId,
        accountId: null,
        localEligibilityVerifiedAt: null,
        createdAt: values.createdAt,
        updatedAt: values.updatedAt,
      },
    });
}

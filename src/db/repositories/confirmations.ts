import { and, eq } from 'drizzle-orm';
import type { Database } from '../client.js';
import { actorNotEligibleForCommunityError, signalNotFoundError } from '../../errors/app-error.js';
import {
  actors,
  signalConfirmations,
  type ActorRow,
  type SignalConfirmationRow,
} from '../schema.js';
import { findPublishedSignalById } from './signals.js';

type Db = Database['db'];

export async function findActiveControlledActor(db: Db, actorId: string): Promise<ActorRow | null> {
  const rows = await db
    .select()
    .from(actors)
    .where(
      and(eq(actors.id, actorId), eq(actors.kind, 'controlled_test'), eq(actors.status, 'active')),
    )
    .limit(1);

  return rows[0] ?? null;
}

export async function findConfirmationByActorAndSignal(
  db: Db,
  actorId: string,
  signalId: string,
): Promise<SignalConfirmationRow | null> {
  const rows = await db
    .select()
    .from(signalConfirmations)
    .where(
      and(eq(signalConfirmations.actorId, actorId), eq(signalConfirmations.signalId, signalId)),
    )
    .limit(1);

  return rows[0] ?? null;
}

export type EnsureConfirmationResult = {
  confirmation: SignalConfirmationRow;
  signalId: string;
};

/**
 * Idempotently ensures a confirmation row exists for the actor/signal pair.
 * Uses INSERT ... ON CONFLICT DO NOTHING, then reads the persistent row.
 */
export async function ensureSignalConfirmation(
  db: Db,
  actorId: string,
  signalId: string,
): Promise<EnsureConfirmationResult> {
  const published = await findPublishedSignalById(db, signalId);
  if (!published) {
    throw signalNotFoundError();
  }

  const actor = await findActiveControlledActor(db, actorId);
  if (!actor) {
    // Missing/inactive configured actor is a setup failure — do not expose internals.
    throw new Error('Controlled confirmation setup is invalid');
  }

  if (actor.communityId !== published.signal.communityId) {
    throw actorNotEligibleForCommunityError();
  }

  const confirmationId = crypto.randomUUID();
  const timestamp = new Date().toISOString();

  await db
    .insert(signalConfirmations)
    .values({
      id: confirmationId,
      signalId,
      actorId,
      confirmedAt: timestamp,
      createdAt: timestamp,
    })
    .onConflictDoNothing({
      target: [signalConfirmations.signalId, signalConfirmations.actorId],
    });

  const confirmation = await findConfirmationByActorAndSignal(db, actorId, signalId);
  if (!confirmation) {
    throw new Error('Controlled confirmation persistence failed');
  }

  return {
    confirmation,
    signalId,
  };
}

export async function getActorConfirmationState(
  db: Db,
  actorId: string,
  signalId: string,
): Promise<{ signalId: string; confirmed: boolean; confirmedAt: string | null }> {
  const published = await findPublishedSignalById(db, signalId);
  if (!published) {
    throw signalNotFoundError();
  }

  const actor = await findActiveControlledActor(db, actorId);
  if (!actor) {
    throw new Error('Controlled confirmation setup is invalid');
  }

  if (actor.communityId !== published.signal.communityId) {
    throw actorNotEligibleForCommunityError();
  }

  const confirmation = await findConfirmationByActorAndSignal(db, actorId, signalId);
  if (!confirmation) {
    return {
      signalId,
      confirmed: false,
      confirmedAt: null,
    };
  }

  return {
    signalId,
    confirmed: true,
    confirmedAt: confirmation.confirmedAt,
  };
}

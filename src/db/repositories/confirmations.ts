import { and, count, eq, inArray } from 'drizzle-orm';
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

export async function findActiveCivicActorByAccountId(
  db: Db,
  accountId: string,
): Promise<ActorRow | null> {
  const rows = await db
    .select()
    .from(actors)
    .where(
      and(eq(actors.accountId, accountId), eq(actors.kind, 'civic'), eq(actors.status, 'active')),
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

/**
 * Idempotently ensures a participant confirmation for a civic actor/signal pair.
 */
export async function ensureParticipantSignalConfirmation(
  db: Db,
  actorId: string,
  signalId: string,
): Promise<EnsureConfirmationResult> {
  const published = await findPublishedSignalById(db, signalId);
  if (!published) {
    throw signalNotFoundError();
  }

  const actorRows = await db
    .select()
    .from(actors)
    .where(and(eq(actors.id, actorId), eq(actors.kind, 'civic'), eq(actors.status, 'active')))
    .limit(1);
  const actor = actorRows[0];
  if (!actor?.accountId) {
    throw new Error('Civic participant confirmation setup is invalid');
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
    throw new Error('Civic participant confirmation persistence failed');
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

/**
 * Aggregate confirmation total for a published signal.
 * Integer only — never returns actor identifiers or confirmer lists.
 */
export async function countConfirmationsForSignal(db: Db, signalId: string): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(signalConfirmations)
    .where(eq(signalConfirmations.signalId, signalId));
  return rows[0]?.value ?? 0;
}

/**
 * Batch aggregate confirmation totals keyed by signal id.
 */
export async function countConfirmationsForSignals(
  db: Db,
  signalIds: readonly string[],
): Promise<Map<string, number>> {
  const totals = new Map<string, number>();
  for (const signalId of signalIds) {
    totals.set(signalId, 0);
  }
  if (signalIds.length === 0) {
    return totals;
  }

  const rows = await db
    .select({
      signalId: signalConfirmations.signalId,
      value: count(),
    })
    .from(signalConfirmations)
    .where(inArray(signalConfirmations.signalId, [...signalIds]))
    .groupBy(signalConfirmations.signalId);

  for (const row of rows) {
    totals.set(row.signalId, row.value);
  }
  return totals;
}

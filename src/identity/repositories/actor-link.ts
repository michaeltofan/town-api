import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { actors, type ActorRow } from '../../db/schema.js';
import { IdentityInvariantError } from '../errors.js';
import { findAccountById } from './accounts.js';

type Db = Database['db'];

export async function linkActorToAccount(
  db: Db,
  input: { actorId: string; accountId: string; at: string },
): Promise<ActorRow> {
  const account = await findAccountById(db, input.accountId);
  if (!account) {
    throw new IdentityInvariantError('ACCOUNT_NOT_FOUND', 'Account was not found');
  }

  const actorRows = await db.select().from(actors).where(eq(actors.id, input.actorId)).limit(1);
  const actor = actorRows[0];
  if (!actor) {
    throw new IdentityInvariantError('ACTOR_NOT_FOUND', 'Actor was not found');
  }

  if (actor.kind === 'controlled_test') {
    throw new IdentityInvariantError(
      'CONTROLLED_ACTOR_CANNOT_LINK',
      'Controlled test actor cannot be linked to an account',
    );
  }

  if (actor.accountId !== null) {
    throw new IdentityInvariantError(
      'ACTOR_ALREADY_LINKED',
      'Actor is already linked to an account',
    );
  }

  const existingLink = await db
    .select()
    .from(actors)
    .where(eq(actors.accountId, input.accountId))
    .limit(1);
  if (existingLink[0]) {
    throw new IdentityInvariantError(
      'ACCOUNT_ALREADY_LINKED',
      'Account is already linked to an actor',
    );
  }

  try {
    const updated = await db
      .update(actors)
      .set({ accountId: input.accountId, updatedAt: input.at })
      .where(eq(actors.id, input.actorId))
      .returning();
    const row = updated[0];
    if (!row) {
      throw new Error('Failed to link actor to account');
    }
    return row;
  } catch (error) {
    if (error instanceof Error && /actors_account_id_unique/i.test(error.message)) {
      throw new IdentityInvariantError(
        'ACCOUNT_ALREADY_LINKED',
        'Account is already linked to an actor',
      );
    }
    throw error;
  }
}

export async function createCivicActor(
  db: Db,
  input: {
    id: string;
    displayLabel: string;
    communityId: string | null;
    createdAt: string;
    updatedAt: string;
  },
): Promise<ActorRow> {
  const rows = await db
    .insert(actors)
    .values({
      id: input.id,
      kind: 'civic',
      status: 'active',
      displayLabel: input.displayLabel,
      communityId: input.communityId,
      accountId: null,
      localEligibilityVerifiedAt: null,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    })
    .returning();
  const row = rows[0];
  if (!row) {
    throw new Error('Failed to create civic actor');
  }
  return row;
}

/**
 * Set-once community binding for local eligibility.
 * Caller must hold the account row lock and decide bind vs idempotent vs conflict
 * before invoking. Executes on the provided transaction handle only.
 */
export async function bindActorLocalEligibility(
  db: Db,
  input: {
    actorId: string;
    communityId: string;
    verifiedAt: string;
    updatedAt: string;
  },
): Promise<ActorRow> {
  const updated = await db
    .update(actors)
    .set({
      communityId: input.communityId,
      localEligibilityVerifiedAt: input.verifiedAt,
      updatedAt: input.updatedAt,
    })
    .where(eq(actors.id, input.actorId))
    .returning();
  const row = updated[0];
  if (!row) {
    throw new IdentityInvariantError('ACTOR_NOT_FOUND', 'Actor was not found');
  }
  return row;
}

import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Database } from '../../src/db/client.js';
import { communities, signals, accounts, type CommunityRow } from '../../src/db/schema.js';
import {
  findCivicProcessBySignalId,
  openVotingIfBallotPreparationElapsed,
} from '../../src/db/repositories/civic-processes.js';
import { insertCivicDeliberationContribution } from '../../src/db/repositories/civic-deliberation.js';
import { insertCivicProposal } from '../../src/db/repositories/civic-proposals.js';
import { ensureParticipantSignalConfirmation } from '../../src/db/repositories/confirmations.js';
import { findActiveCommunityById } from '../../src/db/repositories/communities.js';
import { hashPassword } from '../../src/identity/password-hashing.js';
import {
  createAccountShell,
  ensureWebAuthnUserHandle,
  transitionAccountState,
} from '../../src/identity/repositories/accounts.js';
import {
  createCivicActor,
  linkActorToAccount,
} from '../../src/identity/repositories/actor-link.js';
import { addAccountEmail, verifyEmail } from '../../src/identity/repositories/emails.js';
import {
  createAccountPasswordCredential,
  revokeAccountPasswordCredential,
} from '../../src/identity/repositories/password-credentials.js';
import { recordCommunityCommitmentInTransaction } from '../../src/membership/community-commitment-service.js';

/**
 * Shared provisioning primitives for the Etapa 4 load-test tooling, used by
 * both `loadtest/provision.ts` (the ephemeral per-run pool) and
 * `loadtest/ensure-voting-arena.ts` (the small permanent voting fixture --
 * see `src/db/seeds/loadtest-voting-arena.ts` for why it has to be
 * permanent). Every write here goes through the same repository functions
 * the real routes use, so the same triggers/constraints/invariants apply as
 * in production -- this just drives the state machine directly instead of
 * over HTTP.
 */

export const CONFIRMATION_THRESHOLD = 5;
export const PROPOSAL_THRESHOLD = 5;
export const DELIBERATION_THRESHOLD = 5;

export async function ensureCommunity(
  db: Database['db'],
  input: { id: string; slug: string; position: number; at: string },
): Promise<CommunityRow> {
  const existing = await findActiveCommunityById(db, input.id);
  if (existing) return existing;

  await db.insert(communities).values({
    id: input.id,
    slug: input.slug,
    position: input.position,
    countryCode: 'XX',
    cityName: 'Load Test City',
    displayName: `Load Test Arena ${String(input.position)}`,
    defaultLocale: 'en-US',
    timezone: 'UTC',
    status: 'active',
    createdAt: input.at,
    updatedAt: input.at,
  });
  const row = await findActiveCommunityById(db, input.id);
  if (!row) {
    throw new Error(`Failed to create load-test community ${input.slug}`);
  }
  return row;
}

export async function createSignal(
  db: Database['db'],
  input: {
    id?: string;
    communityId: string;
    slug: string;
    position: number;
    at: string;
    index: number;
  },
): Promise<string> {
  const id = input.id ?? randomUUID();
  await db.insert(signals).values({
    id,
    communityId: input.communityId,
    slug: input.slug,
    position: input.position,
    locale: 'en-US',
    category: 'LOAD TEST',
    area: 'Load Test Area',
    headline: `Load test signal ${String(input.index)}`,
    summary: 'Synthetic signal created for the Etapa 4 capacity drill. Not real civic content.',
    description:
      'This signal was created by the Etapa 4 load-test tooling and is not real civic content.',
    whyItMatters: 'Synthetic load-test fixture.',
    whoIsAffected: 'No one -- synthetic load-test fixture.',
    latestUpdate: 'Synthetic load-test fixture.',
    statusLabel: 'Load test fixture',
    statusNote: 'Synthetic load-test fixture, not a real civic signal.',
    observedLabel: 'Synthetic',
    observedOn: null,
    observedPrecision: 'day',
    authorDisplayName: 'Load Test Fixture',
    authorActorId: null,
    authorAccountId: null,
    mediaUploadId: null,
    imageKey: 'assets/loadtest/placeholder.jpg',
    imageFocusX: 50,
    imageFocusY: 50,
    publicationStatus: 'published',
    publishedAt: input.at,
    hiddenAt: null,
    hiddenReason: null,
    hiddenByAccountId: null,
    createdAt: input.at,
    updatedAt: input.at,
  });
  return id;
}

export async function createLoginAccount(
  db: Database['db'],
  input: {
    accountId?: string;
    actorId?: string;
    email: string;
    password: string;
    communityId: string;
    community: CommunityRow;
    at: string;
  },
): Promise<{ accountId: string; actorId: string }> {
  const accountId = input.accountId ?? randomUUID();
  await createAccountShell(db, { id: accountId, createdAt: input.at, updatedAt: input.at });

  const emailId = randomUUID();
  await addAccountEmail(db, {
    id: emailId,
    accountId,
    email: input.email,
    isPrimary: true,
    createdAt: input.at,
    updatedAt: input.at,
  });
  await verifyEmail(db, { emailId, verifiedAt: input.at });
  await transitionAccountState(db, { accountId, to: 'pending_password', at: input.at });

  const hashed = await hashPassword(input.password);
  await createAccountPasswordCredential(db, {
    id: randomUUID(),
    accountId,
    passwordHash: hashed.hash,
    algorithm: hashed.algorithm,
    parameters: hashed.parameters,
    createdAt: input.at,
  });
  await transitionAccountState(db, { accountId, to: 'pending_passkey', at: input.at });
  await ensureWebAuthnUserHandle(db, {
    accountId,
    handle: randomBytes(32),
    now: input.at,
  });

  const actorId = input.actorId ?? randomUUID();
  await createCivicActor(db, {
    id: actorId,
    displayLabel: 'Load Test Participant',
    communityId: input.communityId,
    createdAt: input.at,
    updatedAt: input.at,
  });
  await linkActorToAccount(db, { actorId, accountId, at: input.at });

  await transitionAccountState(db, { accountId, to: 'active', at: input.at });
  // isOwner bypasses the membership/payment entitlement gate in
  // evaluateCivicAccess -- see the module doc comment for why.
  await db
    .update(accounts)
    .set({ isOwner: true, updatedAt: input.at })
    .where(eq(accounts.id, accountId));

  await recordCommunityCommitmentInTransaction(db, {
    accountId,
    community: input.community,
    now: input.at,
  });

  return { accountId, actorId };
}

/** Revokes the active password credential and issues a fresh one, for reused fixture accounts whose plaintext password can't be recovered across runs. */
export async function resetAccountPassword(
  db: Database['db'],
  input: { accountId: string; password: string; at: string },
): Promise<void> {
  await revokeAccountPasswordCredential(db, { accountId: input.accountId, revokedAt: input.at });
  const hashed = await hashPassword(input.password);
  await createAccountPasswordCredential(db, {
    id: randomUUID(),
    accountId: input.accountId,
    passwordHash: hashed.hash,
    algorithm: hashed.algorithm,
    parameters: hashed.parameters,
    createdAt: input.at,
  });
}

/**
 * Drives a signal's civic process from 'confirmation' all the way to
 * 'voting'. Not idempotent past the first call for a given signal --
 * callers must check `findCivicProcessBySignalId(...).currentStage` first
 * and skip signals already at or past 'voting'.
 */
export async function advanceSignalToVoting(
  db: Database['db'],
  input: { signalId: string; advancerActorIds: string[]; now: Date },
): Promise<void> {
  const nowIso = input.now.toISOString();

  // 1. Cross the confirmation threshold (>= 5 confirmations from distinct actors).
  for (const actorId of input.advancerActorIds.slice(0, CONFIRMATION_THRESHOLD)) {
    await ensureParticipantSignalConfirmation(db, actorId, input.signalId);
  }

  const process = await findCivicProcessBySignalId(db, input.signalId);
  if (!process) {
    throw new Error(`No civic process provisioned for signal ${input.signalId}`);
  }

  // 2. Cross the proposal threshold (>= 5 proposals from distinct actors).
  const proposalIds: string[] = [];
  for (const [i, actorId] of input.advancerActorIds.slice(0, PROPOSAL_THRESHOLD).entries()) {
    const proposalId = randomUUID();
    proposalIds.push(proposalId);
    await insertCivicProposal(db, {
      id: proposalId,
      processId: process.id,
      actorId,
      title: `Load test proposal ${String(i)}`,
      body: 'Synthetic proposal created for the Etapa 4 capacity drill.',
      targetInstitution: null,
      expectedOutcome: 'Synthetic load-test fixture.',
      estimatedResources: null,
      indicativeDeadline: null,
      createdAt: nowIso,
    });
  }
  const targetProposalId = proposalIds[0];
  if (!targetProposalId) {
    throw new Error('No proposal created to anchor deliberation contributions');
  }

  // 3. Cross the deliberation threshold (>= 5 DISTINCT-actor contributions),
  //    backdated so voting_opens_at (transition_at + 10 minutes) has already
  //    elapsed by the time step 4 runs -- otherwise voting stays gated for a
  //    real 10 minutes, same as it would for genuine civic activity.
  const backdated = new Date(input.now.getTime() - 20 * 60_000);
  for (const [i, actorId] of input.advancerActorIds.slice(0, DELIBERATION_THRESHOLD).entries()) {
    const at = new Date(backdated.getTime() + i * 60_000).toISOString();
    await insertCivicDeliberationContribution(db, {
      id: randomUUID(),
      processId: process.id,
      proposalId: targetProposalId,
      actorId,
      intent: 'observation',
      text: 'Synthetic deliberation contribution created for the Etapa 4 capacity drill.',
      replyToContributionId: null,
      createdAt: at,
    });
  }

  // 4. The ballot_preparation -> voting transition is normally lazy (fires
  //    on the next request that touches the process once voting_opens_at
  //    has passed). Call it directly so the process is already in 'voting'
  //    -- with tokens already minted for every actor who existed in the
  //    community at this moment -- before k6 sends a single request.
  await openVotingIfBallotPreparationElapsed(db, { processId: process.id, now: nowIso });

  const after = await findCivicProcessBySignalId(db, input.signalId);
  if (after?.currentStage !== 'voting') {
    throw new Error(
      `Expected signal ${input.signalId} to reach 'voting', got '${after?.currentStage ?? 'unknown'}'`,
    );
  }
}

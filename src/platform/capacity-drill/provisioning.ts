import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { communities, signals, accounts, type CommunityRow } from '../../db/schema.js';
import {
  findCivicProcessBySignalId,
  openVotingIfBallotPreparationElapsed,
} from '../../db/repositories/civic-processes.js';
import { insertCivicDeliberationContribution } from '../../db/repositories/civic-deliberation.js';
import { insertCivicProposal } from '../../db/repositories/civic-proposals.js';
import { ensureParticipantSignalConfirmation } from '../../db/repositories/confirmations.js';
import { findActiveCommunityById } from '../../db/repositories/communities.js';
import { hashPassword } from '../../identity/password-hashing.js';
import {
  createAccountShell,
  ensureWebAuthnUserHandle,
  transitionAccountState,
} from '../../identity/repositories/accounts.js';
import { createCivicActor, linkActorToAccount } from '../../identity/repositories/actor-link.js';
import { addAccountEmail, verifyEmail } from '../../identity/repositories/emails.js';
import { createAccountPasswordCredential } from '../../identity/repositories/password-credentials.js';
import { addPasskeyCredential } from '../../identity/repositories/passkeys.js';
import { recordCommunityCommitmentInTransaction } from '../../membership/community-commitment-service.js';

/**
 * Shared provisioning primitives for the Etapa 4 capacity drill, run only
 * against a brand-new, isolated, temporary Postgres (see fixtures.ts and
 * docs/operations/CAPACITY_DRILL_RUNBOOK.md). Every write goes through the
 * same repository functions the real routes use, so the same triggers/
 * constraints/invariants apply as in production.
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
    cityName: 'Capacity Drill City',
    displayName: `Capacity Drill Arena ${String(input.position)}`,
    defaultLocale: 'en-US',
    timezone: 'UTC',
    status: 'active',
    createdAt: input.at,
    updatedAt: input.at,
  });
  const row = await findActiveCommunityById(db, input.id);
  if (!row) {
    throw new Error(`Failed to create capacity-drill community ${input.slug}`);
  }
  return row;
}

export async function createSignal(
  db: Database['db'],
  input: {
    id: string;
    communityId: string;
    slug: string;
    position: number;
    at: string;
    index: number;
  },
): Promise<string> {
  await db.insert(signals).values({
    id: input.id,
    communityId: input.communityId,
    slug: input.slug,
    position: input.position,
    locale: 'en-US',
    category: 'CAPACITY DRILL',
    area: 'Capacity Drill Area',
    headline: `Capacity drill signal ${String(input.index)}`,
    summary: 'Synthetic signal created for the Etapa 4 capacity drill. Not real civic content.',
    description:
      'This signal was created by the Etapa 4 isolated capacity drill and is not real civic content.',
    whyItMatters: 'Synthetic capacity-drill fixture.',
    whoIsAffected: 'No one -- synthetic capacity-drill fixture.',
    latestUpdate: 'Synthetic capacity-drill fixture.',
    statusLabel: 'Capacity drill fixture',
    statusNote: 'Synthetic capacity-drill fixture, not a real civic signal.',
    observedLabel: 'Synthetic',
    observedOn: null,
    observedPrecision: 'day',
    authorDisplayName: 'Capacity Drill Fixture',
    authorActorId: null,
    authorAccountId: null,
    mediaUploadId: null,
    imageKey: 'assets/capacity-drill/placeholder.jpg',
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
  return input.id;
}

export async function createLoginAccount(
  db: Database['db'],
  input: {
    accountId: string;
    actorId: string;
    email: string;
    password: string;
    communityId: string;
    community: CommunityRow;
    at: string;
  },
): Promise<{ accountId: string; actorId: string }> {
  const { accountId, actorId } = input;
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
  // assertActiveRequirements (identity/repositories/accounts.ts) requires at
  // least one active passkey credential row to reach 'active', regardless of
  // auth method -- these accounts only ever authenticate with a password
  // (see capacity-1000.js), so this credential is synthetic and never used
  // for a real WebAuthn ceremony; it exists purely to satisfy that invariant.
  await addPasskeyCredential(db, {
    id: randomUUID(),
    accountId,
    credentialId: randomBytes(32),
    publicKey: randomBytes(65),
    signCount: 0,
    createdAt: input.at,
  });

  await createCivicActor(db, {
    id: actorId,
    displayLabel: 'Capacity Drill Participant',
    communityId: input.communityId,
    createdAt: input.at,
    updatedAt: input.at,
  });
  await linkActorToAccount(db, { actorId, accountId, at: input.at });

  await transitionAccountState(db, { accountId, to: 'active', at: input.at });
  // isOwner bypasses the membership/payment entitlement gate in
  // evaluateCivicAccess -- no Stripe checkout is ever reachable from this drill.
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

/**
 * Drives a signal's civic process from 'confirmation' all the way to
 * 'voting'. Not idempotent past the first call for a given signal.
 */
export async function advanceSignalToVoting(
  db: Database['db'],
  input: { signalId: string; advancerActorIds: string[]; now: Date },
): Promise<void> {
  const nowIso = input.now.toISOString();

  for (const actorId of input.advancerActorIds.slice(0, CONFIRMATION_THRESHOLD)) {
    await ensureParticipantSignalConfirmation(db, actorId, input.signalId);
  }

  const process = await findCivicProcessBySignalId(db, input.signalId);
  if (!process) {
    throw new Error(`No civic process provisioned for signal ${input.signalId}`);
  }

  const proposalIds: string[] = [];
  for (const [i, actorId] of input.advancerActorIds.slice(0, PROPOSAL_THRESHOLD).entries()) {
    const proposalId = randomUUID();
    proposalIds.push(proposalId);
    await insertCivicProposal(db, {
      id: proposalId,
      processId: process.id,
      actorId,
      title: `Capacity drill proposal ${String(i)}`,
      body: 'Synthetic proposal created for the Etapa 4 capacity drill.',
      targetInstitution: null,
      expectedOutcome: 'Synthetic capacity-drill fixture.',
      estimatedResources: null,
      indicativeDeadline: null,
      createdAt: nowIso,
    });
  }
  const targetProposalId = proposalIds[0];
  if (!targetProposalId) {
    throw new Error('No proposal created to anchor deliberation contributions');
  }

  // Backdated so voting_opens_at (transition_at + 10 minutes) has already
  // elapsed by the time step 4 runs.
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

  await openVotingIfBallotPreparationElapsed(db, { processId: process.id, now: nowIso });

  const after = await findCivicProcessBySignalId(db, input.signalId);
  if (after?.currentStage !== 'voting') {
    throw new Error(
      `Expected signal ${input.signalId} to reach 'voting', got '${after?.currentStage ?? 'unknown'}'`,
    );
  }
}

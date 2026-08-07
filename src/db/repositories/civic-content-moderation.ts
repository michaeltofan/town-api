import { eq } from 'drizzle-orm';
import type { Database } from '../client.js';
import {
  civicDeliberationContributions,
  civicProposals,
  civicVerificationEvidence,
  type CivicDeliberationContributionRow,
  type CivicProposalRow,
  type CivicVerificationEvidenceRow,
  type SignalHideReason,
} from '../schema.js';

type Db = Database['db'];

/**
 * §14 civic content moderation: hide/restore a proposal, deliberation
 * contribution, or verification evidence item — mirrors the existing
 * signals/discussion-contribution hide pattern exactly (hidden, not
 * deleted). Three boring, near-identical pairs rather than one generic
 * helper, matching how signal-submission-moderation.ts and
 * discussion-contribution-moderation.ts are each written per content type.
 */

export type HideCivicProposalResult = { proposal: CivicProposalRow; changed: boolean };

export async function lockCivicProposalById(db: Db, proposalId: string) {
  const rows = await db
    .select()
    .from(civicProposals)
    .where(eq(civicProposals.id, proposalId))
    .limit(1)
    .for('update');
  return rows[0] ?? null;
}

export async function hideCivicProposal(
  db: Db,
  input: { proposalId: string; reason: SignalHideReason; hiddenByAccountId: string; at: string },
): Promise<HideCivicProposalResult | null> {
  const locked = await lockCivicProposalById(db, input.proposalId);
  if (!locked) return null;
  if (locked.hiddenAt !== null) return { proposal: locked, changed: false };

  const rows = await db
    .update(civicProposals)
    .set({
      hiddenAt: input.at,
      hiddenReason: input.reason,
      hiddenByAccountId: input.hiddenByAccountId,
    })
    .where(eq(civicProposals.id, locked.id))
    .returning();
  const row = rows[0];
  if (!row) throw new Error('Failed to hide civic proposal');
  return { proposal: row, changed: true };
}

export async function unhideCivicProposal(
  db: Db,
  input: { proposalId: string },
): Promise<HideCivicProposalResult | null> {
  const locked = await lockCivicProposalById(db, input.proposalId);
  if (!locked) return null;
  if (locked.hiddenAt === null) return { proposal: locked, changed: false };

  const rows = await db
    .update(civicProposals)
    .set({ hiddenAt: null, hiddenReason: null, hiddenByAccountId: null })
    .where(eq(civicProposals.id, locked.id))
    .returning();
  const row = rows[0];
  if (!row) throw new Error('Failed to unhide civic proposal');
  return { proposal: row, changed: true };
}

export type HideCivicDeliberationContributionResult = {
  contribution: CivicDeliberationContributionRow;
  changed: boolean;
};

export async function lockCivicDeliberationContributionById(db: Db, contributionId: string) {
  const rows = await db
    .select()
    .from(civicDeliberationContributions)
    .where(eq(civicDeliberationContributions.id, contributionId))
    .limit(1)
    .for('update');
  return rows[0] ?? null;
}

export async function hideCivicDeliberationContribution(
  db: Db,
  input: {
    contributionId: string;
    reason: SignalHideReason;
    hiddenByAccountId: string;
    at: string;
  },
): Promise<HideCivicDeliberationContributionResult | null> {
  const locked = await lockCivicDeliberationContributionById(db, input.contributionId);
  if (!locked) return null;
  if (locked.hiddenAt !== null) return { contribution: locked, changed: false };

  const rows = await db
    .update(civicDeliberationContributions)
    .set({
      hiddenAt: input.at,
      hiddenReason: input.reason,
      hiddenByAccountId: input.hiddenByAccountId,
    })
    .where(eq(civicDeliberationContributions.id, locked.id))
    .returning();
  const row = rows[0];
  if (!row) throw new Error('Failed to hide civic deliberation contribution');
  return { contribution: row, changed: true };
}

export async function unhideCivicDeliberationContribution(
  db: Db,
  input: { contributionId: string },
): Promise<HideCivicDeliberationContributionResult | null> {
  const locked = await lockCivicDeliberationContributionById(db, input.contributionId);
  if (!locked) return null;
  if (locked.hiddenAt === null) return { contribution: locked, changed: false };

  const rows = await db
    .update(civicDeliberationContributions)
    .set({ hiddenAt: null, hiddenReason: null, hiddenByAccountId: null })
    .where(eq(civicDeliberationContributions.id, locked.id))
    .returning();
  const row = rows[0];
  if (!row) throw new Error('Failed to unhide civic deliberation contribution');
  return { contribution: row, changed: true };
}

export type HideCivicVerificationEvidenceResult = {
  evidence: CivicVerificationEvidenceRow;
  changed: boolean;
};

export async function lockCivicVerificationEvidenceById(db: Db, evidenceId: string) {
  const rows = await db
    .select()
    .from(civicVerificationEvidence)
    .where(eq(civicVerificationEvidence.id, evidenceId))
    .limit(1)
    .for('update');
  return rows[0] ?? null;
}

export async function hideCivicVerificationEvidence(
  db: Db,
  input: { evidenceId: string; reason: SignalHideReason; hiddenByAccountId: string; at: string },
): Promise<HideCivicVerificationEvidenceResult | null> {
  const locked = await lockCivicVerificationEvidenceById(db, input.evidenceId);
  if (!locked) return null;
  if (locked.hiddenAt !== null) return { evidence: locked, changed: false };

  const rows = await db
    .update(civicVerificationEvidence)
    .set({
      hiddenAt: input.at,
      hiddenReason: input.reason,
      hiddenByAccountId: input.hiddenByAccountId,
    })
    .where(eq(civicVerificationEvidence.id, locked.id))
    .returning();
  const row = rows[0];
  if (!row) throw new Error('Failed to hide civic verification evidence');
  return { evidence: row, changed: true };
}

export async function unhideCivicVerificationEvidence(
  db: Db,
  input: { evidenceId: string },
): Promise<HideCivicVerificationEvidenceResult | null> {
  const locked = await lockCivicVerificationEvidenceById(db, input.evidenceId);
  if (!locked) return null;
  if (locked.hiddenAt === null) return { evidence: locked, changed: false };

  const rows = await db
    .update(civicVerificationEvidence)
    .set({ hiddenAt: null, hiddenReason: null, hiddenByAccountId: null })
    .where(eq(civicVerificationEvidence.id, locked.id))
    .returning();
  const row = rows[0];
  if (!row) throw new Error('Failed to unhide civic verification evidence');
  return { evidence: row, changed: true };
}

import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  emailChallenges,
  webauthnChallenges,
  type EmailChallengePurpose,
  type EmailChallengeRow,
  type WebAuthnChallengePurpose,
  type WebAuthnChallengeRow,
} from '../../db/schema.js';
import { IdentityInvariantError } from '../errors.js';
import { assertHashedBytes } from '../hashing.js';

type Db = Database['db'];

function assertNotExpired(expiresAt: string, now: string, code: string): void {
  if (new Date(now).getTime() >= new Date(expiresAt).getTime()) {
    throw new IdentityInvariantError(code, 'Challenge has expired');
  }
}

export async function createEmailChallenge(
  db: Db,
  input: {
    id: string;
    accountId: string | null;
    emailNormalized: string;
    purpose: EmailChallengePurpose;
    secretHash: Buffer;
    expiresAt: string;
    createdAt: string;
  },
): Promise<EmailChallengeRow> {
  const secretHash = assertHashedBytes(input.secretHash, 'email challenge secretHash');
  if (new Date(input.expiresAt).getTime() <= new Date(input.createdAt).getTime()) {
    throw new IdentityInvariantError(
      'INVALID_CHALLENGE_WINDOW',
      'Challenge expiry must be after creation',
    );
  }

  const rows = await db
    .insert(emailChallenges)
    .values({
      id: input.id,
      accountId: input.accountId,
      emailNormalized: input.emailNormalized,
      purpose: input.purpose,
      secretHash,
      expiresAt: input.expiresAt,
      consumedAt: null,
      revokedAt: null,
      attemptCount: 0,
      createdAt: input.createdAt,
    })
    .returning();
  const row = rows[0];
  if (!row) {
    throw new Error('Failed to create email challenge');
  }
  return row;
}

/**
 * Invalidate previous unconsumed, unrevoked, unexpired verify_email challenges
 * for the same account/email setup. Does not delete history.
 */
export async function revokeActiveEmailChallengesForSetup(
  db: Db,
  input: {
    accountId: string;
    emailNormalized: string;
    purpose: EmailChallengePurpose;
    now: string;
    excludeChallengeId?: string;
  },
): Promise<number> {
  const conditions = [
    eq(emailChallenges.accountId, input.accountId),
    eq(emailChallenges.emailNormalized, input.emailNormalized),
    eq(emailChallenges.purpose, input.purpose),
    isNull(emailChallenges.consumedAt),
    isNull(emailChallenges.revokedAt),
    gt(emailChallenges.expiresAt, input.now),
  ];
  if (input.excludeChallengeId !== undefined) {
    conditions.push(sql`${emailChallenges.id} <> ${input.excludeChallengeId}`);
  }

  const updated = await db
    .update(emailChallenges)
    .set({ revokedAt: input.now })
    .where(and(...conditions))
    .returning({ id: emailChallenges.id });
  return updated.length;
}

export async function consumeEmailChallenge(
  db: Db,
  input: { challengeId: string; now: string },
): Promise<EmailChallengeRow> {
  const existing = await db
    .select()
    .from(emailChallenges)
    .where(eq(emailChallenges.id, input.challengeId))
    .limit(1);
  const challenge = existing[0];
  if (!challenge) {
    throw new IdentityInvariantError('CHALLENGE_NOT_FOUND', 'Challenge was not found');
  }
  if (challenge.consumedAt !== null) {
    throw new IdentityInvariantError('CHALLENGE_ALREADY_CONSUMED', 'Challenge already consumed');
  }
  if (challenge.revokedAt !== null) {
    throw new IdentityInvariantError('CHALLENGE_REVOKED', 'Challenge has been revoked');
  }
  assertNotExpired(challenge.expiresAt, input.now, 'CHALLENGE_EXPIRED');

  const updated = await db
    .update(emailChallenges)
    .set({ consumedAt: input.now })
    .where(
      and(
        eq(emailChallenges.id, input.challengeId),
        isNull(emailChallenges.consumedAt),
        isNull(emailChallenges.revokedAt),
        gt(emailChallenges.expiresAt, input.now),
      ),
    )
    .returning();
  const row = updated[0];
  if (!row) {
    throw new IdentityInvariantError('CHALLENGE_ALREADY_CONSUMED', 'Challenge already consumed');
  }
  return row;
}

export async function incrementEmailChallengeAttemptCount(
  db: Db,
  input: { challengeId: string },
): Promise<EmailChallengeRow> {
  const updated = await db
    .update(emailChallenges)
    .set({
      attemptCount: sql`${emailChallenges.attemptCount} + 1`,
    })
    .where(
      and(
        eq(emailChallenges.id, input.challengeId),
        isNull(emailChallenges.consumedAt),
        isNull(emailChallenges.revokedAt),
      ),
    )
    .returning();
  const row = updated[0];
  if (!row) {
    throw new IdentityInvariantError('CHALLENGE_NOT_FOUND', 'Challenge was not found');
  }
  return row;
}

export async function findEmailChallengeById(
  db: Db,
  challengeId: string,
): Promise<EmailChallengeRow | null> {
  const rows = await db
    .select()
    .from(emailChallenges)
    .where(eq(emailChallenges.id, challengeId))
    .limit(1);
  return rows[0] ?? null;
}

export async function findLatestEmailChallengeForSetup(
  db: Db,
  input: {
    accountId: string;
    emailNormalized: string;
    purpose: EmailChallengePurpose;
  },
): Promise<EmailChallengeRow | null> {
  const rows = await db
    .select()
    .from(emailChallenges)
    .where(
      and(
        eq(emailChallenges.accountId, input.accountId),
        eq(emailChallenges.emailNormalized, input.emailNormalized),
        eq(emailChallenges.purpose, input.purpose),
      ),
    )
    .orderBy(sql`${emailChallenges.createdAt} desc`)
    .limit(1);
  return rows[0] ?? null;
}

export async function createWebAuthnChallenge(
  db: Db,
  input: {
    id: string;
    accountId: string | null;
    sessionId?: string | null;
    purpose: WebAuthnChallengePurpose;
    challengeHash: Buffer;
    expiresAt: string;
    createdAt: string;
  },
): Promise<WebAuthnChallengeRow> {
  const challengeHash = assertHashedBytes(input.challengeHash, 'webauthn challengeHash');
  if (new Date(input.expiresAt).getTime() <= new Date(input.createdAt).getTime()) {
    throw new IdentityInvariantError(
      'INVALID_CHALLENGE_WINDOW',
      'Challenge expiry must be after creation',
    );
  }

  const rows = await db
    .insert(webauthnChallenges)
    .values({
      id: input.id,
      accountId: input.accountId,
      sessionId: input.sessionId ?? null,
      purpose: input.purpose,
      challengeHash,
      expiresAt: input.expiresAt,
      consumedAt: null,
      revokedAt: null,
      createdAt: input.createdAt,
    })
    .returning();
  const row = rows[0];
  if (!row) {
    throw new Error('Failed to create webauthn challenge');
  }
  return row;
}

/**
 * Invalidate previous unconsumed, unrevoked, unexpired WebAuthn challenges for an account/purpose.
 * Retains audit history; does not delete rows.
 */
export async function revokeActiveWebAuthnChallengesForAccount(
  db: Db,
  input: {
    accountId: string;
    purpose: WebAuthnChallengePurpose;
    now: string;
    excludeChallengeId?: string;
  },
): Promise<number> {
  const conditions = [
    eq(webauthnChallenges.accountId, input.accountId),
    eq(webauthnChallenges.purpose, input.purpose),
    isNull(webauthnChallenges.consumedAt),
    isNull(webauthnChallenges.revokedAt),
    gt(webauthnChallenges.expiresAt, input.now),
  ];
  if (input.excludeChallengeId !== undefined) {
    conditions.push(sql`${webauthnChallenges.id} <> ${input.excludeChallengeId}`);
  }

  const updated = await db
    .update(webauthnChallenges)
    .set({ revokedAt: input.now })
    .where(and(...conditions))
    .returning({ id: webauthnChallenges.id });
  return updated.length;
}

export async function revokeActiveWebAuthnChallengesForSession(
  db: Db,
  input: {
    sessionId: string;
    purpose: WebAuthnChallengePurpose;
    now: string;
    excludeChallengeId?: string;
  },
): Promise<number> {
  const conditions = [
    eq(webauthnChallenges.sessionId, input.sessionId),
    eq(webauthnChallenges.purpose, input.purpose),
    isNull(webauthnChallenges.consumedAt),
    isNull(webauthnChallenges.revokedAt),
    gt(webauthnChallenges.expiresAt, input.now),
  ];
  if (input.excludeChallengeId !== undefined) {
    conditions.push(sql`${webauthnChallenges.id} <> ${input.excludeChallengeId}`);
  }

  const updated = await db
    .update(webauthnChallenges)
    .set({ revokedAt: input.now })
    .where(and(...conditions))
    .returning({ id: webauthnChallenges.id });
  return updated.length;
}

export async function findWebAuthnChallengeById(
  db: Db,
  challengeId: string,
): Promise<WebAuthnChallengeRow | null> {
  const rows = await db
    .select()
    .from(webauthnChallenges)
    .where(eq(webauthnChallenges.id, challengeId))
    .limit(1);
  return rows[0] ?? null;
}

export async function consumeWebAuthnChallenge(
  db: Db,
  input: { challengeId: string; now: string },
): Promise<WebAuthnChallengeRow> {
  const existing = await db
    .select()
    .from(webauthnChallenges)
    .where(eq(webauthnChallenges.id, input.challengeId))
    .limit(1);
  const challenge = existing[0];
  if (!challenge) {
    throw new IdentityInvariantError('CHALLENGE_NOT_FOUND', 'Challenge was not found');
  }
  if (challenge.consumedAt !== null) {
    throw new IdentityInvariantError('CHALLENGE_ALREADY_CONSUMED', 'Challenge already consumed');
  }
  if (challenge.revokedAt !== null) {
    throw new IdentityInvariantError('CHALLENGE_REVOKED', 'Challenge has been revoked');
  }
  assertNotExpired(challenge.expiresAt, input.now, 'CHALLENGE_EXPIRED');

  const updated = await db
    .update(webauthnChallenges)
    .set({ consumedAt: input.now })
    .where(
      and(
        eq(webauthnChallenges.id, input.challengeId),
        isNull(webauthnChallenges.consumedAt),
        isNull(webauthnChallenges.revokedAt),
        gt(webauthnChallenges.expiresAt, input.now),
      ),
    )
    .returning();
  const row = updated[0];
  if (!row) {
    throw new IdentityInvariantError('CHALLENGE_ALREADY_CONSUMED', 'Challenge already consumed');
  }
  return row;
}

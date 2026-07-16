import { eq } from 'drizzle-orm';
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
  assertNotExpired(challenge.expiresAt, input.now, 'CHALLENGE_EXPIRED');

  const updated = await db
    .update(emailChallenges)
    .set({ consumedAt: input.now })
    .where(eq(emailChallenges.id, input.challengeId))
    .returning();
  const row = updated[0];
  if (!row) {
    throw new Error('Failed to consume email challenge');
  }
  return row;
}

export async function createWebAuthnChallenge(
  db: Db,
  input: {
    id: string;
    accountId: string | null;
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
      purpose: input.purpose,
      challengeHash,
      expiresAt: input.expiresAt,
      consumedAt: null,
      createdAt: input.createdAt,
    })
    .returning();
  const row = rows[0];
  if (!row) {
    throw new Error('Failed to create webauthn challenge');
  }
  return row;
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
  assertNotExpired(challenge.expiresAt, input.now, 'CHALLENGE_EXPIRED');

  const updated = await db
    .update(webauthnChallenges)
    .set({ consumedAt: input.now })
    .where(eq(webauthnChallenges.id, input.challengeId))
    .returning();
  const row = updated[0];
  if (!row) {
    throw new Error('Failed to consume webauthn challenge');
  }
  return row;
}

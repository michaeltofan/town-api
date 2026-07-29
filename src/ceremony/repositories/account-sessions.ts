import { and, asc, count, eq, gt, isNull, ne } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  accountEmails,
  accountSessions,
  accounts,
  actors,
  passkeyCredentials,
  type AccountSessionClientType,
  type AccountSessionRevocationReason,
  type AccountSessionRow,
} from '../../db/schema.js';
import { assertHashedBytes } from '../../identity/hashing.js';
import { appendIdentitySecurityEvent } from '../../identity/repositories/security-events.js';
import { CeremonyInvariantError } from '../errors.js';
import {
  computeAbsoluteExpiresAt,
  computeIdleExpiresAt,
  isAtOrBefore,
  isBefore,
  isSensitiveOperationFresh,
  SESSION_ABSOLUTE_TIMEOUT_HOURS,
  SESSION_IDLE_TIMEOUT_MINUTES,
} from '../policy.js';

type Db = Database['db'];

const APPROVED_CLIENT_TYPES = new Set<AccountSessionClientType>(['web', 'mobile']);
const APPROVED_REVOCATION_REASONS = new Set<AccountSessionRevocationReason>([
  'logout',
  'logout_all',
  'rotated',
  'account_suspended',
  'account_closed',
  'recovery_completed',
  'credential_compromised',
  'security_version_changed',
  'passkey_added',
  'passkey_revoked',
  'password_changed',
]);

async function assertSessionEligibleAccount(db: Db, accountId: string): Promise<void> {
  const accountRows = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
  const account = accountRows[0];
  if (!account) {
    throw new CeremonyInvariantError('ACCOUNT_NOT_FOUND', 'Account was not found');
  }
  if (
    account.status === 'pending_email' ||
    account.status === 'pending_password' ||
    account.status === 'pending_passkey'
  ) {
    throw new CeremonyInvariantError(
      'SESSION_REQUIRES_ACTIVE_ACCOUNT',
      'Sessions require an active account',
    );
  }
  if (account.status === 'suspended') {
    throw new CeremonyInvariantError(
      'SESSION_ACCOUNT_SUSPENDED',
      'Suspended accounts cannot receive sessions',
    );
  }
  if (account.status === 'closed') {
    throw new CeremonyInvariantError(
      'SESSION_ACCOUNT_CLOSED',
      'Closed accounts cannot receive sessions',
    );
  }
  if (account.status !== 'active') {
    throw new CeremonyInvariantError(
      'SESSION_REQUIRES_ACTIVE_ACCOUNT',
      'Sessions require an active account',
    );
  }

  const primary = await db
    .select()
    .from(accountEmails)
    .where(
      and(
        eq(accountEmails.accountId, accountId),
        eq(accountEmails.isPrimary, true),
        isNull(accountEmails.revokedAt),
      ),
    )
    .limit(1);
  if (primary[0]?.verifiedAt == null) {
    throw new CeremonyInvariantError(
      'SESSION_REQUIRES_VERIFIED_PRIMARY_EMAIL',
      'Sessions require a verified primary email',
    );
  }

  const passkeys = await db
    .select({ value: count() })
    .from(passkeyCredentials)
    .where(and(eq(passkeyCredentials.accountId, accountId), isNull(passkeyCredentials.revokedAt)));
  if ((passkeys[0]?.value ?? 0) < 1) {
    throw new CeremonyInvariantError(
      'SESSION_REQUIRES_ACTIVE_PASSKEY',
      'Sessions require at least one active passkey',
    );
  }

  const linked = await db.select().from(actors).where(eq(actors.accountId, accountId)).limit(1);
  if (!linked[0]) {
    throw new CeremonyInvariantError(
      'SESSION_REQUIRES_LINKED_ACTOR',
      'Sessions require a linked civic actor',
    );
  }
}

function assertPolicyWindows(input: {
  createdAt: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
}): void {
  const createdMs = new Date(input.createdAt).getTime();
  const idleMs = new Date(input.idleExpiresAt).getTime();
  const absoluteMs = new Date(input.absoluteExpiresAt).getTime();
  const maxAbsoluteMs = new Date(computeAbsoluteExpiresAt(input.createdAt)).getTime();
  const maxIdleMs = new Date(
    computeIdleExpiresAt(input.createdAt, input.absoluteExpiresAt),
  ).getTime();

  if (absoluteMs > maxAbsoluteMs) {
    throw new CeremonyInvariantError(
      'SESSION_ABSOLUTE_POLICY_VIOLATION',
      `Absolute expiry must remain within ${String(SESSION_ABSOLUTE_TIMEOUT_HOURS)} hours`,
    );
  }
  if (idleMs > maxIdleMs) {
    throw new CeremonyInvariantError(
      'SESSION_IDLE_POLICY_VIOLATION',
      `Idle expiry must remain within ${String(SESSION_IDLE_TIMEOUT_MINUTES)} minutes and absolute expiry`,
    );
  }
  if (idleMs <= createdMs || absoluteMs <= createdMs) {
    throw new CeremonyInvariantError(
      'INVALID_SESSION_WINDOW',
      'Session expiry must be after creation',
    );
  }
  if (idleMs > absoluteMs) {
    throw new CeremonyInvariantError(
      'INVALID_SESSION_WINDOW',
      'Idle expiry cannot exceed absolute expiry',
    );
  }
}

function isSessionActive(session: AccountSessionRow, now: string): boolean {
  if (session.revokedAt !== null) {
    return false;
  }
  if (!isBefore(now, session.absoluteExpiresAt)) {
    return false;
  }
  if (!isBefore(now, session.idleExpiresAt)) {
    return false;
  }
  return true;
}

/**
 * Create an opaque server-side account session from a pre-hashed token.
 * Setup grants and recovery grants cannot create sessions.
 */
export async function createAccountSession(
  db: Db,
  input: {
    id: string;
    accountId: string;
    tokenHash: Buffer;
    clientType: AccountSessionClientType;
    createdAt: string;
    authenticatedAt?: string;
    securityVersion?: number;
    recoveryRecentAt?: string | null;
    authenticatedPasskeyId?: string | null;
    freshAuthenticatedAt?: string | null;
    eventId?: string;
    requestId?: string | null;
  },
): Promise<AccountSessionRow> {
  const tokenHash = assertHashedBytes(input.tokenHash, 'session tokenHash');
  if (!APPROVED_CLIENT_TYPES.has(input.clientType)) {
    throw new CeremonyInvariantError('INVALID_SESSION_CLIENT_TYPE', 'Invalid session client type');
  }

  const securityVersion = input.securityVersion ?? 1;
  if (securityVersion < 1) {
    throw new CeremonyInvariantError(
      'INVALID_SECURITY_VERSION',
      'Session security_version must be >= 1',
    );
  }

  await assertSessionEligibleAccount(db, input.accountId);

  const authenticatedAt = input.authenticatedAt ?? input.createdAt;
  if (isBefore(authenticatedAt, input.createdAt)) {
    throw new CeremonyInvariantError(
      'INVALID_SESSION_WINDOW',
      'authenticated_at cannot precede created_at',
    );
  }

  const absoluteExpiresAt = computeAbsoluteExpiresAt(input.createdAt);
  const idleExpiresAt = computeIdleExpiresAt(input.createdAt, absoluteExpiresAt);
  assertPolicyWindows({
    createdAt: input.createdAt,
    idleExpiresAt,
    absoluteExpiresAt,
  });

  const rows = await db
    .insert(accountSessions)
    .values({
      id: input.id,
      accountId: input.accountId,
      tokenHash,
      clientType: input.clientType,
      createdAt: input.createdAt,
      authenticatedAt,
      lastSeenAt: input.createdAt,
      idleExpiresAt,
      absoluteExpiresAt,
      revokedAt: null,
      revocationReason: null,
      recoveryRecentAt: input.recoveryRecentAt ?? null,
      authenticatedPasskeyId: input.authenticatedPasskeyId ?? null,
      freshAuthenticatedAt: input.freshAuthenticatedAt ?? null,
      securityVersion,
    })
    .returning();
  const row = rows[0];
  if (!row) {
    throw new Error('Failed to create account session');
  }

  if (input.eventId) {
    await appendIdentitySecurityEvent(db, {
      id: input.eventId,
      accountId: input.accountId,
      eventType: 'session_created',
      occurredAt: input.createdAt,
      requestId: input.requestId ?? null,
      metadata: { sessionId: row.id, clientType: row.clientType },
    });
  }

  return row;
}

export async function findActiveAccountSessionByTokenHash(
  db: Db,
  input: { tokenHash: Buffer; now: string },
): Promise<AccountSessionRow> {
  const tokenHash = assertHashedBytes(input.tokenHash, 'session tokenHash');
  const rows = await db
    .select()
    .from(accountSessions)
    .where(eq(accountSessions.tokenHash, tokenHash))
    .limit(1);
  const session = rows[0];
  if (!session) {
    throw new CeremonyInvariantError('SESSION_NOT_FOUND', 'Account session was not found');
  }
  if (session.revokedAt !== null) {
    throw new CeremonyInvariantError('SESSION_REVOKED', 'Account session has been revoked');
  }
  if (!isBefore(input.now, session.absoluteExpiresAt)) {
    throw new CeremonyInvariantError(
      'SESSION_ABSOLUTE_EXPIRED',
      'Account session absolute timeout exceeded',
    );
  }
  if (!isBefore(input.now, session.idleExpiresAt)) {
    throw new CeremonyInvariantError(
      'SESSION_IDLE_EXPIRED',
      'Account session idle timeout exceeded',
    );
  }
  return session;
}

export async function touchAccountSession(
  db: Db,
  input: { sessionId: string; now: string },
): Promise<AccountSessionRow> {
  const existing = await db
    .select()
    .from(accountSessions)
    .where(eq(accountSessions.id, input.sessionId))
    .limit(1);
  const session = existing[0];
  if (!session) {
    throw new CeremonyInvariantError('SESSION_NOT_FOUND', 'Account session was not found');
  }
  if (!isSessionActive(session, input.now)) {
    if (session.revokedAt !== null) {
      throw new CeremonyInvariantError('SESSION_REVOKED', 'Account session has been revoked');
    }
    if (!isBefore(input.now, session.absoluteExpiresAt)) {
      throw new CeremonyInvariantError(
        'SESSION_ABSOLUTE_EXPIRED',
        'Account session absolute timeout exceeded',
      );
    }
    throw new CeremonyInvariantError(
      'SESSION_IDLE_EXPIRED',
      'Account session idle timeout exceeded',
    );
  }

  const lastSeenAt = isBefore(session.lastSeenAt, input.now) ? input.now : session.lastSeenAt;
  const idleExpiresAt = computeIdleExpiresAt(lastSeenAt, session.absoluteExpiresAt);

  const updated = await db
    .update(accountSessions)
    .set({
      lastSeenAt,
      idleExpiresAt,
    })
    .where(
      and(
        eq(accountSessions.id, input.sessionId),
        isNull(accountSessions.revokedAt),
        gt(accountSessions.idleExpiresAt, input.now),
        gt(accountSessions.absoluteExpiresAt, input.now),
      ),
    )
    .returning();
  const row = updated[0];
  if (!row) {
    throw new CeremonyInvariantError('SESSION_TOUCH_FAILED', 'Failed to touch account session');
  }
  return row;
}

export async function rotateAccountSession(
  db: Db,
  input: {
    oldSessionId: string;
    newSessionId: string;
    newTokenHash: Buffer;
    now: string;
    freshAuthenticatedAt?: string | null;
    authenticatedPasskeyId?: string | null;
    eventId?: string;
    requestId?: string | null;
  },
): Promise<{ previous: AccountSessionRow; replacement: AccountSessionRow }> {
  return db.transaction(async (tx) => rotateAccountSessionTx(tx as unknown as Db, input));
}

/**
 * Rotate within an existing transaction (no nested transaction wrapper).
 */
export async function rotateAccountSessionTx(
  db: Db,
  input: {
    oldSessionId: string;
    newSessionId: string;
    newTokenHash: Buffer;
    now: string;
    freshAuthenticatedAt?: string | null;
    authenticatedPasskeyId?: string | null;
    eventId?: string;
    requestId?: string | null;
  },
): Promise<{ previous: AccountSessionRow; replacement: AccountSessionRow }> {
  const newTokenHash = assertHashedBytes(input.newTokenHash, 'session tokenHash');

  const revoked = await db
    .update(accountSessions)
    .set({
      revokedAt: input.now,
      revocationReason: 'rotated',
    })
    .where(
      and(
        eq(accountSessions.id, input.oldSessionId),
        isNull(accountSessions.revokedAt),
        gt(accountSessions.idleExpiresAt, input.now),
        gt(accountSessions.absoluteExpiresAt, input.now),
      ),
    )
    .returning();
  const previous = revoked[0];
  if (!previous) {
    const existing = await db
      .select()
      .from(accountSessions)
      .where(eq(accountSessions.id, input.oldSessionId))
      .limit(1);
    const session = existing[0];
    if (!session) {
      throw new CeremonyInvariantError('SESSION_NOT_FOUND', 'Account session was not found');
    }
    if (session.revokedAt !== null) {
      throw new CeremonyInvariantError('SESSION_REVOKED', 'Account session has been revoked');
    }
    if (!isBefore(input.now, session.idleExpiresAt)) {
      throw new CeremonyInvariantError(
        'SESSION_IDLE_EXPIRED',
        'Account session idle timeout exceeded',
      );
    }
    throw new CeremonyInvariantError(
      'SESSION_ABSOLUTE_EXPIRED',
      'Account session absolute timeout exceeded',
    );
  }

  const absoluteExpiresAt = previous.absoluteExpiresAt;
  const idleExpiresAt = computeIdleExpiresAt(input.now, absoluteExpiresAt);
  const freshAuthenticatedAt =
    input.freshAuthenticatedAt !== undefined
      ? input.freshAuthenticatedAt
      : previous.freshAuthenticatedAt;
  const authenticatedPasskeyId =
    input.authenticatedPasskeyId !== undefined
      ? input.authenticatedPasskeyId
      : previous.authenticatedPasskeyId;

  const inserted = await db
    .insert(accountSessions)
    .values({
      id: input.newSessionId,
      accountId: previous.accountId,
      tokenHash: newTokenHash,
      clientType: previous.clientType,
      createdAt: previous.createdAt,
      authenticatedAt: previous.authenticatedAt,
      lastSeenAt: input.now,
      idleExpiresAt,
      absoluteExpiresAt,
      revokedAt: null,
      revocationReason: null,
      recoveryRecentAt: previous.recoveryRecentAt,
      authenticatedPasskeyId,
      freshAuthenticatedAt,
      securityVersion: previous.securityVersion,
    })
    .returning();
  const replacement = inserted[0];
  if (!replacement) {
    throw new Error('Failed to create replacement session');
  }

  if (input.eventId) {
    await appendIdentitySecurityEvent(db, {
      id: input.eventId,
      accountId: previous.accountId,
      eventType: 'session_rotated',
      occurredAt: input.now,
      requestId: input.requestId ?? null,
      metadata: {
        previousSessionId: previous.id,
        replacementSessionId: replacement.id,
      },
    });
  }

  return { previous, replacement };
}

export async function updateAccountSessionFreshness(
  db: Db,
  input: {
    sessionId: string;
    freshAuthenticatedAt: string;
    authenticatedPasskeyId: string;
  },
): Promise<AccountSessionRow> {
  const updated = await db
    .update(accountSessions)
    .set({
      freshAuthenticatedAt: input.freshAuthenticatedAt,
      authenticatedPasskeyId: input.authenticatedPasskeyId,
    })
    .where(and(eq(accountSessions.id, input.sessionId), isNull(accountSessions.revokedAt)))
    .returning();
  const row = updated[0];
  if (!row) {
    throw new CeremonyInvariantError('SESSION_NOT_FOUND', 'Account session was not found');
  }
  return row;
}

async function revokeMatchingSessions(
  db: Db,
  input: {
    accountId: string;
    reason: AccountSessionRevocationReason;
    now: string;
    excludeSessionId?: string;
    eventId?: string;
    requestId?: string | null;
  },
): Promise<AccountSessionRow[]> {
  if (!APPROVED_REVOCATION_REASONS.has(input.reason)) {
    throw new CeremonyInvariantError(
      'INVALID_REVOCATION_REASON',
      'Invalid account session revocation reason',
    );
  }

  const conditions = [
    eq(accountSessions.accountId, input.accountId),
    isNull(accountSessions.revokedAt),
  ];
  if (input.excludeSessionId !== undefined) {
    conditions.push(ne(accountSessions.id, input.excludeSessionId));
  }

  const updated = await db
    .update(accountSessions)
    .set({
      revokedAt: input.now,
      revocationReason: input.reason,
    })
    .where(and(...conditions))
    .returning();

  if (input.eventId && updated.length > 0) {
    await appendIdentitySecurityEvent(db, {
      id: input.eventId,
      accountId: input.accountId,
      eventType: 'session_revoked',
      occurredAt: input.now,
      requestId: input.requestId ?? null,
      metadata: {
        reason: input.reason,
        revokedCount: updated.length,
      },
    });
  }

  return updated;
}

export async function revokeAccountSession(
  db: Db,
  input: {
    sessionId: string;
    reason: AccountSessionRevocationReason;
    now: string;
    eventId?: string;
    requestId?: string | null;
  },
): Promise<AccountSessionRow> {
  if (!APPROVED_REVOCATION_REASONS.has(input.reason)) {
    throw new CeremonyInvariantError(
      'INVALID_REVOCATION_REASON',
      'Invalid account session revocation reason',
    );
  }

  const updated = await db
    .update(accountSessions)
    .set({
      revokedAt: input.now,
      revocationReason: input.reason,
    })
    .where(and(eq(accountSessions.id, input.sessionId), isNull(accountSessions.revokedAt)))
    .returning();
  const row = updated[0];
  if (row) {
    if (input.eventId) {
      await appendIdentitySecurityEvent(db, {
        id: input.eventId,
        accountId: row.accountId,
        eventType: 'session_revoked',
        occurredAt: input.now,
        requestId: input.requestId ?? null,
        metadata: { sessionId: row.id, reason: input.reason },
      });
    }
    return row;
  }

  const existing = await db
    .select()
    .from(accountSessions)
    .where(eq(accountSessions.id, input.sessionId))
    .limit(1);
  const session = existing[0];
  if (!session) {
    throw new CeremonyInvariantError('SESSION_NOT_FOUND', 'Account session was not found');
  }
  // Repeated revocation is deterministic and safe.
  return session;
}

export async function revokeAllAccountSessions(
  db: Db,
  input: {
    accountId: string;
    reason: AccountSessionRevocationReason;
    now: string;
    eventId?: string;
    requestId?: string | null;
  },
): Promise<AccountSessionRow[]> {
  return revokeMatchingSessions(db, input);
}

export async function revokeAllOtherAccountSessions(
  db: Db,
  input: {
    accountId: string;
    keepSessionId: string;
    reason: AccountSessionRevocationReason;
    now: string;
    eventId?: string;
    requestId?: string | null;
  },
): Promise<AccountSessionRow[]> {
  return revokeMatchingSessions(db, {
    accountId: input.accountId,
    reason: input.reason,
    now: input.now,
    excludeSessionId: input.keepSessionId,
    ...(input.eventId !== undefined ? { eventId: input.eventId } : {}),
    ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
  });
}

export function sessionSupportsSensitiveOperation(
  session: AccountSessionRow,
  now: string,
): boolean {
  if (!isSessionActive(session, now)) {
    return false;
  }
  return isSensitiveOperationFresh(session.authenticatedAt, now);
}

/** Internal/test-only listing helper. Not a public API. */
export async function listActiveAccountSessionsForAccount(
  db: Db,
  input: { accountId: string; now: string },
): Promise<AccountSessionRow[]> {
  const rows = await db
    .select()
    .from(accountSessions)
    .where(
      and(
        eq(accountSessions.accountId, input.accountId),
        isNull(accountSessions.revokedAt),
        gt(accountSessions.idleExpiresAt, input.now),
        gt(accountSessions.absoluteExpiresAt, input.now),
      ),
    )
    .orderBy(asc(accountSessions.createdAt));
  return rows;
}

export function assertAuthenticatedAtUnchangedByTouch(
  before: AccountSessionRow,
  after: AccountSessionRow,
): void {
  if (before.authenticatedAt !== after.authenticatedAt) {
    throw new CeremonyInvariantError(
      'AUTHENTICATED_AT_MUTATED',
      'Ordinary activity must not refresh authenticated_at',
    );
  }
  if (!isAtOrBefore(before.lastSeenAt, after.lastSeenAt)) {
    throw new CeremonyInvariantError(
      'LAST_SEEN_MOVED_BACKWARD',
      'last_seen_at must not move backward',
    );
  }
}

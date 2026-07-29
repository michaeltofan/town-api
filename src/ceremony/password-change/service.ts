import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { Env } from '../../config/env.js';
import type { Database } from '../../db/client.js';
import {
  accountPasswordCredentials,
  type AccountSessionClientType,
  type AccountSessionRow,
} from '../../db/schema.js';
import { CeremonyInvariantError } from '../errors.js';
import { hashPassword, verifyPasswordStrict } from '../../identity/password-hashing.js';
import {
  normalizeAndValidateInitialPassword,
  PasswordPolicyError,
} from '../../identity/password-policy.js';
import { findAccountById, lockAccountById } from '../../identity/repositories/accounts.js';
import {
  createAccountPasswordCredential,
  findActiveAccountPasswordCredential,
  revokeAccountPasswordCredential,
} from '../../identity/repositories/password-credentials.js';
import { appendIdentitySecurityEvent } from '../../identity/repositories/security-events.js';
import { generateSessionToken, hashSessionToken } from '../passkey-authentication/crypto.js';
import {
  revokeAllOtherAccountSessions,
  rotateAccountSessionTx,
} from '../repositories/account-sessions.js';
import { requirePasswordChangeConfig } from './config.js';
import { PASSWORD_CHANGE_PUBLIC_ERROR_MESSAGE } from './policy.js';
import { reservePasswordChangeAccountAttempt } from './rate-limits.js';

type Db = Database['db'];

export type PasswordChangeDeps = {
  env: Env;
  now: () => string;
  generateId?: () => string;
  generateToken?: () => string;
  /**
   * Optional test seam for observing Argon2 verification without weakening
   * production defaults. Production always uses verifyPasswordStrict.
   */
  verifyPasswordStrict?: typeof verifyPasswordStrict;
  /**
   * Optional test seam for observing Argon2 hashing without weakening
   * production defaults. Production always uses hashPassword.
   */
  hashPassword?: typeof hashPassword;
  /**
   * Optional test seam awaited after verify+hash and before the final transaction.
   * Production omits this (no await).
   */
  beforeFinalTransaction?: () => Promise<void>;
  /**
   * Optional test seam awaited inside the final transaction after the credential
   * row is locked and rechecked, before revoke/create. Production omits this.
   */
  afterCredentialLocked?: () => Promise<void>;
  /**
   * Optional test seam awaited inside the final transaction after revoke+create
   * and before session rotation. Production omits this.
   */
  afterCredentialMutation?: () => Promise<void>;
  /**
   * Optional test seam replacing rotateAccountSessionTx.
   * Production always uses rotateAccountSessionTx.
   */
  rotateAccountSessionTx?: typeof rotateAccountSessionTx;
};

export class PasswordChangeFailedError extends Error {
  readonly code = 'PASSWORD_CHANGE_FAILED';
  readonly failureCategory: string;

  constructor(failureCategory: string) {
    super(PASSWORD_CHANGE_PUBLIC_ERROR_MESSAGE);
    this.name = 'PasswordChangeFailedError';
    this.failureCategory = failureCategory;
  }
}

export class RateLimitedError extends Error {
  readonly code = 'RATE_LIMITED';

  constructor() {
    super('Rate limit exceeded.');
    this.name = 'RateLimitedError';
  }
}

export class SessionNotAuthorizedError extends Error {
  readonly code = 'SESSION_NOT_AUTHORIZED';

  constructor() {
    super('Session is not authorized.');
    this.name = 'SessionNotAuthorizedError';
  }
}

export type PasswordChangeSuccess =
  | {
      clientType: 'web';
      status: 'PASSWORD_CHANGED';
      session: AccountSessionRow;
      rawToken: string;
    }
  | {
      clientType: 'mobile';
      status: 'PASSWORD_CHANGED';
      session: AccountSessionRow;
      rawToken: string;
      sessionExpiresAt: string;
    };

/**
 * Change the active password for a session-authenticated account.
 * Requires current password (fresh proof). Rotates the current session and
 * revokes all other sessions. Does not create accounts or repair credentials.
 */
export async function changeAccountPassword(
  db: Db,
  deps: PasswordChangeDeps,
  input: {
    session: AccountSessionRow;
    currentPassword: string;
    newPassword: string;
    requestId?: string | null;
  },
): Promise<PasswordChangeSuccess> {
  const config = requirePasswordChangeConfig(deps.env);
  const now = deps.now();
  const generateId = deps.generateId ?? (() => randomUUID());
  const generateToken = deps.generateToken ?? generateSessionToken;
  const verify = deps.verifyPasswordStrict ?? verifyPasswordStrict;
  const hash = deps.hashPassword ?? hashPassword;
  const rotateSession = deps.rotateAccountSessionTx ?? rotateAccountSessionTx;
  const accountId = input.session.accountId;

  // Policy / equality checks emit no security events.
  if (input.currentPassword === input.newPassword) {
    throw new PasswordChangeFailedError('passwords_equal');
  }

  let normalizedNewPassword: string;
  try {
    normalizedNewPassword = normalizeAndValidateInitialPassword(input.newPassword);
  } catch (error) {
    if (error instanceof PasswordPolicyError) {
      throw new PasswordChangeFailedError('password_policy_violation');
    }
    throw error;
  }

  const reservation = await reservePasswordChangeAccountAttempt(db, {
    rateLimitHashKey: config.rateLimitHashKey,
    accountId,
    now,
    requestId: input.requestId ?? null,
    failureCategory: 'rate_limited',
  });
  if (reservation.status === 'throttled') {
    throw new RateLimitedError();
  }

  const activeCredential = await findActiveAccountPasswordCredential(db, accountId);
  if (!activeCredential) {
    // Missing stored hash → hard failure (500). No password_change_failed event.
    throw new Error('Active password credential is required for password change');
  }

  const passwordOk = await verify(input.currentPassword, activeCredential.passwordHash);
  if (!passwordOk) {
    await appendIdentitySecurityEvent(db, {
      id: generateId(),
      accountId,
      eventType: 'password_change_failed',
      occurredAt: now,
      requestId: input.requestId ?? null,
      metadata: {
        purpose: 'password_change',
        failureCategory: 'password_mismatch',
      },
    });
    throw new PasswordChangeFailedError('password_mismatch');
  }

  const hashed = await hash(normalizedNewPassword);
  const previousCredentialId = activeCredential.id;
  const newCredentialId = generateId();
  const newSessionId = generateId();
  const rawToken = generateToken();
  const newTokenHash = hashSessionToken({
    hashKey: config.sessionTokenHashKey,
    clientType: input.session.clientType as AccountSessionClientType,
    token: rawToken,
  });

  if (deps.beforeFinalTransaction) {
    await deps.beforeFinalTransaction();
  }

  let replacement: AccountSessionRow;
  try {
    replacement = await db.transaction(async (tx) => {
      const dbTx = tx as unknown as Db;

      const account = await lockAccountById(dbTx, accountId);
      if (account?.status !== 'active') {
        throw new PasswordChangeFailedError('account_not_active');
      }

      const lockedRows = await dbTx
        .select()
        .from(accountPasswordCredentials)
        .where(
          and(
            eq(accountPasswordCredentials.accountId, accountId),
            isNull(accountPasswordCredentials.revokedAt),
          ),
        )
        .limit(1)
        .for('update');
      const lockedCredential = lockedRows[0];
      if (lockedCredential?.id !== previousCredentialId) {
        throw new PasswordChangeFailedError('credential_race');
      }

      if (deps.afterCredentialLocked) {
        await deps.afterCredentialLocked();
      }

      await revokeAccountPasswordCredential(dbTx, {
        accountId,
        revokedAt: now,
      });

      await createAccountPasswordCredential(dbTx, {
        id: newCredentialId,
        accountId,
        passwordHash: hashed.hash,
        algorithm: hashed.algorithm,
        parameters: hashed.parameters,
        createdAt: now,
      });

      if (deps.afterCredentialMutation) {
        await deps.afterCredentialMutation();
      }

      let rotated: { replacement: AccountSessionRow };
      try {
        rotated = await rotateSession(dbTx, {
          oldSessionId: input.session.id,
          newSessionId,
          newTokenHash,
          now,
          freshAuthenticatedAt: now,
          authenticatedPasskeyId: input.session.authenticatedPasskeyId,
          eventId: generateId(),
          requestId: input.requestId ?? null,
        });
      } catch (error) {
        if (
          error instanceof CeremonyInvariantError &&
          (error.code === 'SESSION_NOT_FOUND' ||
            error.code === 'SESSION_REVOKED' ||
            error.code === 'SESSION_IDLE_EXPIRED' ||
            error.code === 'SESSION_ABSOLUTE_EXPIRED')
        ) {
          throw new PasswordChangeFailedError('session_inactive');
        }
        throw error;
      }

      await revokeAllOtherAccountSessions(dbTx, {
        accountId,
        keepSessionId: rotated.replacement.id,
        reason: 'password_changed',
        now,
        eventId: generateId(),
        requestId: input.requestId ?? null,
      });

      await appendIdentitySecurityEvent(dbTx, {
        id: generateId(),
        accountId,
        eventType: 'password_credential_changed',
        occurredAt: now,
        requestId: input.requestId ?? null,
        metadata: {
          purpose: 'password_change',
          previousCredentialId,
          replacementCredentialId: newCredentialId,
        },
      });

      return rotated.replacement;
    });
  } catch (error) {
    if (
      error instanceof PasswordChangeFailedError &&
      (error.failureCategory === 'account_not_active' ||
        error.failureCategory === 'credential_race' ||
        error.failureCategory === 'session_inactive')
    ) {
      await appendIdentitySecurityEvent(db, {
        id: generateId(),
        accountId,
        eventType: 'password_change_failed',
        occurredAt: now,
        requestId: input.requestId ?? null,
        metadata: {
          purpose: 'password_change',
          failureCategory: error.failureCategory,
        },
      }).catch(() => undefined);
    }
    throw error;
  }

  // Confirm account still readable for response shaping (defensive).
  const account = await findAccountById(db, accountId);
  if (account?.status !== 'active') {
    throw new SessionNotAuthorizedError();
  }

  if (input.session.clientType === 'web') {
    return {
      clientType: 'web',
      status: 'PASSWORD_CHANGED',
      session: replacement,
      rawToken,
    };
  }

  return {
    clientType: 'mobile',
    status: 'PASSWORD_CHANGED',
    session: replacement,
    rawToken,
    sessionExpiresAt: replacement.absoluteExpiresAt,
  };
}

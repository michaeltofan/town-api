import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { Env } from '../../config/env.js';
import type { Database } from '../../db/client.js';
import {
  accountPasswordCredentials,
  type AccountSessionClientType,
  type AccountSessionRow,
} from '../../db/schema.js';
import { normalizeEmail } from '../../identity/email-normalize.js';
import { verifyPassword } from '../../identity/password-hashing.js';
import { findAccountById, lockAccountById } from '../../identity/repositories/accounts.js';
import {
  findActiveEmailByNormalized,
  findVerifiedPrimaryEmailForAccount,
} from '../../identity/repositories/emails.js';
import { findActiveAccountPasswordCredential } from '../../identity/repositories/password-credentials.js';
import { appendIdentitySecurityEvent } from '../../identity/repositories/security-events.js';
import { CeremonyInvariantError } from '../errors.js';
import { generateSessionToken, hashSessionToken } from '../passkey-authentication/crypto.js';
import { createAccountSession } from '../repositories/account-sessions.js';
import { requirePasswordSignInConfig } from './config.js';
import { getPasswordSignInDummyHash } from './dummy-hash.js';
import {
  isPasswordSignInEmailThrottled,
  recordPasswordSignInEmailAttempt,
  reservePasswordSignInIpAttempt,
} from './rate-limits.js';

type Db = Database['db'];

export type PasswordSignInDeps = {
  env: Env;
  now: () => string;
  generateId?: () => string;
  generateToken?: () => string;
  /**
   * Optional test seam for observing Argon2 verification without weakening
   * production defaults. Production always uses verifyPassword.
   */
  verifyPassword?: typeof verifyPassword;
  /**
   * Optional test seam for observing dummy-hash retrieval. Production always
   * uses getPasswordSignInDummyHash.
   */
  getDummyHash?: typeof getPasswordSignInDummyHash;
};

export class AuthenticationFailedError extends Error {
  readonly code = 'AUTHENTICATION_FAILED';
  readonly failureCategory: string;

  constructor(failureCategory: string) {
    super('Authentication could not be completed.');
    this.name = 'AuthenticationFailedError';
    this.failureCategory = failureCategory;
  }
}

export type PasswordSignInSuccess =
  | {
      clientType: 'web';
      status: 'AUTHENTICATED';
      session: AccountSessionRow;
      rawToken: string;
    }
  | {
      clientType: 'mobile';
      status: 'AUTHENTICATED';
      session: AccountSessionRow;
      rawToken: string;
      sessionExpiresAt: string;
    };

/**
 * Authenticate an existing active account with email + password.
 * Never creates, repairs, merges, replaces, or duplicates an account.
 * Never creates password or passkey credentials.
 * Issues a session through the same createAccountSession path as passkey auth.
 */
export async function authenticateWithPassword(
  db: Db,
  deps: PasswordSignInDeps,
  input: {
    email: string;
    password: string;
    clientType: AccountSessionClientType;
    ip: string;
    requestId?: string | null;
  },
): Promise<PasswordSignInSuccess> {
  const config = requirePasswordSignInConfig(deps.env);
  const now = deps.now();
  const generateId = deps.generateId ?? (() => randomUUID());
  const generateToken = deps.generateToken ?? generateSessionToken;
  const verify = deps.verifyPassword ?? verifyPassword;
  const getDummyHash = deps.getDummyHash ?? getPasswordSignInDummyHash;

  let accountIdForEvents: string | null = null;

  const emitAuthenticationFailed = async (category: string): Promise<never> => {
    await appendIdentitySecurityEvent(db, {
      id: generateId(),
      accountId: accountIdForEvents,
      eventType: 'authentication_failed',
      occurredAt: now,
      requestId: input.requestId ?? null,
      metadata: {
        purpose: 'password_sign_in',
        failureCategory: category,
        clientType: input.clientType,
      },
    }).catch(() => undefined);
    throw new AuthenticationFailedError(category);
  };

  const failEmailOnly = async (category: string, emailNormalized: string): Promise<never> => {
    await recordPasswordSignInEmailAttempt(db, {
      rateLimitHashKey: config.rateLimitHashKey,
      emailNormalized,
      now,
      throttled: category === 'rate_limited',
      accountId: accountIdForEvents,
      requestId: input.requestId ?? null,
      failureCategory: category,
    }).catch(() => undefined);
    return await emitAuthenticationFailed(category);
  };

  // Atomically consume one IP slot before normalization and any Argon2 work.
  const ipReservation = await reservePasswordSignInIpAttempt(db, {
    rateLimitHashKey: config.rateLimitHashKey,
    ip: input.ip,
    now,
    requestId: input.requestId ?? null,
    failureCategory: 'rate_limited',
  });
  if (ipReservation.status === 'throttled') {
    return await emitAuthenticationFailed('rate_limited');
  }

  let emailNormalized: string;
  try {
    emailNormalized = normalizeEmail(input.email);
  } catch {
    await verify(input.password, await getDummyHash()).catch(() => false);
    return await emitAuthenticationFailed('email_invalid');
  }

  if (
    await isPasswordSignInEmailThrottled(db, {
      rateLimitHashKey: config.rateLimitHashKey,
      emailNormalized,
      now,
    })
  ) {
    return await failEmailOnly('rate_limited', emailNormalized);
  }

  const emailRow = await findActiveEmailByNormalized(db, emailNormalized);
  const account = emailRow ? await findAccountById(db, emailRow.accountId) : null;
  if (account) {
    accountIdForEvents = account.id;
  }

  const credential = account ? await findActiveAccountPasswordCredential(db, account.id) : null;

  const targetHash = credential?.passwordHash ?? (await getDummyHash());
  const passwordOk = await verify(input.password, targetHash);

  if (!emailRow) {
    return await failEmailOnly('email_unknown', emailNormalized);
  }
  if (emailRow.revokedAt !== null) {
    return await failEmailOnly('email_revoked', emailNormalized);
  }
  if (!emailRow.isPrimary || emailRow.verifiedAt == null) {
    return await failEmailOnly('email_not_verified_primary', emailNormalized);
  }
  if (!account) {
    return await failEmailOnly('account_unknown', emailNormalized);
  }
  if (account.status === 'pending_email') {
    return await failEmailOnly('account_pending_email', emailNormalized);
  }
  if (account.status === 'pending_password') {
    return await failEmailOnly('account_pending_password', emailNormalized);
  }
  if (account.status === 'pending_passkey') {
    return await failEmailOnly('account_pending_passkey', emailNormalized);
  }
  if (account.status === 'suspended') {
    return await failEmailOnly('account_suspended', emailNormalized);
  }
  if (account.status === 'closed') {
    return await failEmailOnly('account_closed', emailNormalized);
  }
  if (account.status !== 'active') {
    return await failEmailOnly('account_not_active', emailNormalized);
  }
  if (credential?.revokedAt !== null) {
    return await failEmailOnly('password_credential_missing', emailNormalized);
  }
  if (!passwordOk) {
    return await failEmailOnly('password_mismatch', emailNormalized);
  }

  const sessionId = generateId();
  const rawToken = generateToken();
  const tokenHash = hashSessionToken({
    hashKey: config.sessionTokenHashKey,
    clientType: input.clientType,
    token: rawToken,
  });

  let session: AccountSessionRow;
  try {
    session = await db.transaction(async (tx) => {
      const dbTx = tx as unknown as Db;

      const lockedAccount = await lockAccountById(dbTx, account.id);
      if (lockedAccount?.status !== 'active') {
        throw new AuthenticationFailedError('account_not_active_recheck');
      }

      const primaryEmail = await findVerifiedPrimaryEmailForAccount(dbTx, lockedAccount.id, {
        forUpdate: true,
      });
      if (primaryEmail?.emailNormalized !== emailNormalized) {
        throw new AuthenticationFailedError('email_not_eligible_recheck');
      }

      const credentialLocked = await dbTx
        .select()
        .from(accountPasswordCredentials)
        .where(
          and(
            eq(accountPasswordCredentials.accountId, lockedAccount.id),
            isNull(accountPasswordCredentials.revokedAt),
          ),
        )
        .limit(1)
        .for('update');
      const lockedCredential = credentialLocked[0];
      if (lockedCredential?.id !== credential.id) {
        throw new AuthenticationFailedError('password_credential_inactive_recheck');
      }

      const created = await createAccountSession(dbTx, {
        id: sessionId,
        accountId: lockedAccount.id,
        tokenHash,
        clientType: input.clientType,
        createdAt: now,
        authenticatedPasskeyId: null,
        eventId: generateId(),
        requestId: input.requestId ?? null,
      });

      await appendIdentitySecurityEvent(dbTx, {
        id: generateId(),
        accountId: lockedAccount.id,
        eventType: 'authentication_succeeded',
        occurredAt: now,
        requestId: input.requestId ?? null,
        metadata: {
          purpose: 'password_sign_in',
          clientType: input.clientType,
        },
      });

      return created;
    });
  } catch (error) {
    if (error instanceof AuthenticationFailedError) {
      return await failEmailOnly(error.failureCategory, emailNormalized);
    }
    if (error instanceof CeremonyInvariantError) {
      return await failEmailOnly(`session_${error.code.toLowerCase()}`, emailNormalized);
    }
    return await failEmailOnly('session_create_failed', emailNormalized);
  }

  await recordPasswordSignInEmailAttempt(db, {
    rateLimitHashKey: config.rateLimitHashKey,
    emailNormalized,
    now,
    throttled: false,
    accountId: account.id,
    requestId: input.requestId ?? null,
  }).catch(() => undefined);

  if (input.clientType === 'web') {
    return { clientType: 'web', status: 'AUTHENTICATED', session, rawToken };
  }
  return {
    clientType: 'mobile',
    status: 'AUTHENTICATED',
    session,
    rawToken,
    sessionExpiresAt: session.absoluteExpiresAt,
  };
}

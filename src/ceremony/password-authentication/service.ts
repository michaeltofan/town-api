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
import { isPasswordSignInThrottled, recordPasswordSignInAttempt } from './rate-limits.js';

type Db = Database['db'];

export type PasswordSignInDeps = {
  env: Env;
  now: () => string;
  generateId?: () => string;
  generateToken?: () => string;
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

  let emailNormalized: string;
  try {
    emailNormalized = normalizeEmail(input.email);
  } catch {
    await verifyPassword(input.password, await getPasswordSignInDummyHash()).catch(() => false);
    throw new AuthenticationFailedError('email_invalid');
  }

  let accountIdForEvents: string | null = null;

  const fail = async (category: string): Promise<never> => {
    await recordPasswordSignInAttempt(db, {
      rateLimitHashKey: config.rateLimitHashKey,
      emailNormalized,
      ip: input.ip,
      now,
      throttled: category === 'rate_limited',
      accountId: accountIdForEvents,
      requestId: input.requestId ?? null,
      failureCategory: category,
    }).catch(() => undefined);
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

  if (
    await isPasswordSignInThrottled(db, {
      rateLimitHashKey: config.rateLimitHashKey,
      emailNormalized,
      ip: input.ip,
      now,
    })
  ) {
    return await fail('rate_limited');
  }

  const emailRow = await findActiveEmailByNormalized(db, emailNormalized);
  const account = emailRow ? await findAccountById(db, emailRow.accountId) : null;
  if (account) {
    accountIdForEvents = account.id;
  }

  const credential = account ? await findActiveAccountPasswordCredential(db, account.id) : null;

  const targetHash = credential?.passwordHash ?? (await getPasswordSignInDummyHash());
  const passwordOk = await verifyPassword(input.password, targetHash);

  if (!emailRow) {
    return await fail('email_unknown');
  }
  if (emailRow.revokedAt !== null) {
    return await fail('email_revoked');
  }
  if (!emailRow.isPrimary || emailRow.verifiedAt == null) {
    return await fail('email_not_verified_primary');
  }
  if (!account) {
    return await fail('account_unknown');
  }
  if (account.status === 'pending_email') {
    return await fail('account_pending_email');
  }
  if (account.status === 'pending_password') {
    return await fail('account_pending_password');
  }
  if (account.status === 'pending_passkey') {
    return await fail('account_pending_passkey');
  }
  if (account.status === 'suspended') {
    return await fail('account_suspended');
  }
  if (account.status === 'closed') {
    return await fail('account_closed');
  }
  if (account.status !== 'active') {
    return await fail('account_not_active');
  }
  if (credential?.revokedAt !== null) {
    return await fail('password_credential_missing');
  }
  if (!passwordOk) {
    return await fail('password_mismatch');
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
      return await fail(error.failureCategory);
    }
    if (error instanceof CeremonyInvariantError) {
      return await fail(`session_${error.code.toLowerCase()}`);
    }
    return await fail('session_create_failed');
  }

  await recordPasswordSignInAttempt(db, {
    rateLimitHashKey: config.rateLimitHashKey,
    emailNormalized,
    ip: input.ip,
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

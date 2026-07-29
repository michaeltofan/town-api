import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Env } from '../../config/env.js';
import type { Database } from '../../db/client.js';
import { setupGrants } from '../../db/schema.js';
import { IdentityInvariantError } from '../../identity/errors.js';
import { hashPassword } from '../../identity/password-hashing.js';
import {
  normalizeAndValidateInitialPassword,
  PasswordPolicyError,
} from '../../identity/password-policy.js';
import {
  findAccountById,
  lockAccountById,
  transitionAccountState,
} from '../../identity/repositories/accounts.js';
import { findVerifiedPrimaryEmailForAccount } from '../../identity/repositories/emails.js';
import {
  createAccountPasswordCredential,
  findActiveAccountPasswordCredential,
} from '../../identity/repositories/password-credentials.js';
import { appendIdentitySecurityEvent } from '../../identity/repositories/security-events.js';
import { computeSetupGrantExpiresAt } from '../policy.js';
import {
  consumeSetupGrant,
  createSetupGrant,
  revokeActiveSetupGrantsForAccount,
  revokeSetupGrant,
} from '../repositories/setup-grants.js';
import { generateSetupGrantToken, hashOpaqueToken } from '../email-verification/crypto.js';
import { requirePasswordSetupConfig, type PasswordSetupConfig } from './config.js';
import { isPasswordSetupGrantThrottled, recordPasswordSetupGrantAttempt } from './rate-limits.js';

type Db = Database['db'];

export type PasswordSetupDeps = {
  env: Env;
  now: () => string;
  generateId?: () => string;
  generateSetupToken?: () => string;
};

export type PasswordSetupSuccess = {
  status: 'PASSWORD_SET';
  setupGrant: string;
  setupGrantExpiresAt: string;
};

export class PasswordSetupFailedError extends Error {
  readonly code = 'PASSWORD_SETUP_FAILED';
  readonly failureCategory: string;

  constructor(failureCategory: string) {
    super('Password setup could not be completed.');
    this.name = 'PasswordSetupFailedError';
    this.failureCategory = failureCategory;
  }
}

async function resolveAuthorizedPasswordSetup(
  db: Db,
  config: PasswordSetupConfig,
  input: { setupToken: string; now: string },
): Promise<{ grantId: string; accountId: string }> {
  const tokenHash = hashOpaqueToken({
    hashKey: config.setupGrantHashKey,
    purpose: 'initial_password_setup',
    token: input.setupToken,
  });

  const grantRows = await db
    .select()
    .from(setupGrants)
    .where(eq(setupGrants.tokenHash, tokenHash))
    .limit(1);
  const grant = grantRows[0];
  if (!grant) {
    throw new PasswordSetupFailedError('setup_grant_unknown');
  }
  if (grant.purpose !== 'initial_password_setup') {
    throw new PasswordSetupFailedError('setup_grant_wrong_purpose');
  }
  if (grant.consumedAt !== null) {
    throw new PasswordSetupFailedError('setup_grant_consumed');
  }
  if (grant.revokedAt !== null) {
    throw new PasswordSetupFailedError('setup_grant_revoked');
  }
  if (new Date(input.now).getTime() >= new Date(grant.expiresAt).getTime()) {
    throw new PasswordSetupFailedError('setup_grant_expired');
  }

  const account = await findAccountById(db, grant.accountId);
  if (!account) {
    throw new PasswordSetupFailedError('account_missing');
  }
  if (account.status !== 'pending_password') {
    throw new PasswordSetupFailedError('account_wrong_state');
  }

  const email = await findVerifiedPrimaryEmailForAccount(db, account.id);
  if (!email) {
    throw new PasswordSetupFailedError('verified_email_missing');
  }

  return { grantId: grant.id, accountId: account.id };
}

/**
 * Complete initial password setup for a pending_password account.
 * Hashes outside the DB transaction, then atomically persists the credential,
 * consumes the password-setup grant, transitions to pending_passkey, and issues
 * a fresh initial_passkey_registration grant. Creates no session.
 */
export async function completeInitialPasswordSetup(
  db: Db,
  deps: PasswordSetupDeps,
  input: {
    setupToken: string;
    password: string;
    requestId?: string | null;
  },
): Promise<PasswordSetupSuccess> {
  const config = requirePasswordSetupConfig(deps.env);
  const now = deps.now();
  const generateId = deps.generateId ?? (() => randomUUID());
  const generateSetupToken = deps.generateSetupToken ?? generateSetupGrantToken;

  let normalizedPassword: string;
  try {
    normalizedPassword = normalizeAndValidateInitialPassword(input.password);
  } catch (error) {
    if (error instanceof PasswordPolicyError) {
      throw new PasswordSetupFailedError('password_policy_violation');
    }
    throw error;
  }

  const { grantId, accountId } = await resolveAuthorizedPasswordSetup(db, config, {
    setupToken: input.setupToken,
    now,
  });

  if (
    await isPasswordSetupGrantThrottled(db, {
      rateLimitHashKey: config.rateLimitHashKey,
      grantId,
      now,
    })
  ) {
    await recordPasswordSetupGrantAttempt(db, {
      rateLimitHashKey: config.rateLimitHashKey,
      grantId,
      accountId,
      now,
      throttled: true,
      requestId: input.requestId ?? null,
      failureCategory: 'rate_limited',
    });
    await revokeSetupGrant(db, { grantId, now }).catch(() => undefined);
    throw new PasswordSetupFailedError('rate_limited');
  }

  const existing = await findActiveAccountPasswordCredential(db, accountId);
  if (existing) {
    await recordPasswordSetupGrantAttempt(db, {
      rateLimitHashKey: config.rateLimitHashKey,
      grantId,
      accountId,
      now,
      throttled: false,
      requestId: input.requestId ?? null,
      failureCategory: 'password_already_set',
    });
    throw new PasswordSetupFailedError('password_already_set');
  }

  // Hash outside long-held database locks. Plaintext stays in request memory only.
  const hashed = await hashPassword(normalizedPassword);

  const passkeyRawToken = generateSetupToken();
  const passkeyTokenHash = hashOpaqueToken({
    hashKey: config.setupGrantHashKey,
    purpose: 'initial_passkey_registration',
    token: passkeyRawToken,
  });
  const passkeyGrantExpiresAt = computeSetupGrantExpiresAt(now);
  const credentialId = generateId();
  const passkeyGrantId = generateId();
  const eventId = generateId();

  try {
    await db.transaction(async (tx) => {
      const dbTx = tx as unknown as Db;

      const grantRows = await dbTx
        .select()
        .from(setupGrants)
        .where(eq(setupGrants.id, grantId))
        .limit(1)
        .for('update');
      const grant = grantRows[0];
      if (
        grant?.purpose !== 'initial_password_setup' ||
        grant.consumedAt !== null ||
        grant.revokedAt !== null ||
        new Date(now).getTime() >= new Date(grant.expiresAt).getTime()
      ) {
        throw new PasswordSetupFailedError('setup_grant_unavailable');
      }

      const lockedAccount = await lockAccountById(dbTx, accountId);
      if (lockedAccount?.status !== 'pending_password') {
        throw new PasswordSetupFailedError('account_wrong_state');
      }

      const email = await findVerifiedPrimaryEmailForAccount(dbTx, accountId);
      if (!email) {
        throw new PasswordSetupFailedError('verified_email_missing');
      }

      try {
        await createAccountPasswordCredential(dbTx, {
          id: credentialId,
          accountId,
          passwordHash: hashed.hash,
          algorithm: hashed.algorithm,
          parameters: hashed.parameters,
          createdAt: now,
        });
      } catch (error) {
        if (
          error instanceof IdentityInvariantError &&
          error.code === 'DUPLICATE_ACTIVE_PASSWORD_CREDENTIAL'
        ) {
          throw new PasswordSetupFailedError('password_already_set');
        }
        throw error;
      }

      await consumeSetupGrant(dbTx, {
        grantId,
        accountId,
        purpose: 'initial_password_setup',
        now,
      });
      await revokeActiveSetupGrantsForAccount(dbTx, {
        accountId,
        purpose: 'initial_password_setup',
        now,
        excludeGrantId: grantId,
      });

      await transitionAccountState(dbTx, {
        accountId,
        to: 'pending_passkey',
        at: now,
      });

      await createSetupGrant(dbTx, {
        id: passkeyGrantId,
        accountId,
        tokenHash: passkeyTokenHash,
        purpose: 'initial_passkey_registration',
        createdAt: now,
        expiresAt: passkeyGrantExpiresAt,
      });

      await appendIdentitySecurityEvent(dbTx, {
        id: eventId,
        accountId,
        eventType: 'password_credential_created',
        occurredAt: now,
        requestId: input.requestId ?? null,
        metadata: {
          purpose: 'initial_password_setup',
        },
      });
    });
  } catch (error) {
    if (error instanceof PasswordSetupFailedError) {
      await recordPasswordSetupGrantAttempt(db, {
        rateLimitHashKey: config.rateLimitHashKey,
        grantId,
        accountId,
        now,
        throttled: false,
        requestId: input.requestId ?? null,
        failureCategory: error.failureCategory,
      }).catch(() => undefined);
      throw error;
    }
    await recordPasswordSetupGrantAttempt(db, {
      rateLimitHashKey: config.rateLimitHashKey,
      grantId,
      accountId,
      now,
      throttled: false,
      requestId: input.requestId ?? null,
      failureCategory: 'persist_failed',
    }).catch(() => undefined);
    throw new PasswordSetupFailedError('persist_failed');
  }

  return {
    status: 'PASSWORD_SET',
    setupGrant: passkeyRawToken,
    setupGrantExpiresAt: passkeyGrantExpiresAt,
  };
}

import { randomUUID } from 'node:crypto';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Env } from '../../config/env.js';
import type { Database } from '../../db/client.js';
import { emailChallenges, recoveryGrants, webauthnChallenges } from '../../db/schema.js';
import { normalizeEmail } from '../../identity/email-normalize.js';
import {
  findAccountById,
  lockAccountById,
  setAccountRecoveryCompletedAt,
} from '../../identity/repositories/accounts.js';
import {
  createEmailChallenge,
  createWebAuthnChallenge,
  incrementEmailChallengeAttemptCount,
  revokeActiveEmailChallengesForSetup,
  revokeActiveWebAuthnChallengesForAccount,
  findWebAuthnChallengeById,
} from '../../identity/repositories/challenges.js';
import {
  findActiveEmailByNormalized,
  findVerifiedPrimaryEmailForAccount,
} from '../../identity/repositories/emails.js';
import { addPasskeyCredential, listActivePasskeys } from '../../identity/repositories/passkeys.js';
import {
  consumeRecoveryGrant,
  createRecoveryGrant,
  findRecoveryGrantByTokenHash,
  revokeActiveRecoveryGrantsForAccount,
  revokeRecoveryGrant,
} from '../../identity/repositories/recovery-grants.js';
import { appendIdentitySecurityEvent } from '../../identity/repositories/security-events.js';
import { addMinutes } from '../policy.js';
import { revokeAllAccountSessions } from '../repositories/account-sessions.js';
import {
  hashWebAuthnChallenge,
  verifyWebAuthnChallengeHash,
} from '../passkey-registration/crypto.js';
import { requireAccountRecoveryConfig, type AccountRecoveryConfig } from './config.js';
import {
  generateRecoveryCode,
  generateRecoveryGrantToken,
  hashRecoveryCode,
  hashRecoveryGrantToken,
  verifyRecoveryCode,
} from './crypto.js';
import type { AccountRecoveryDeliveryAdapter } from './delivery.js';
import {
  ACCOUNT_RECOVERY_CODE_TTL_MINUTES,
  ACCOUNT_RECOVERY_GRANT_TTL_MINUTES,
  ACCOUNT_RECOVERY_MAX_ATTEMPTS,
  CIVIC_ACTOR_DISPLAY_LABEL,
  isSupportedLocale,
  WEBAUTHN_CHALLENGE_TIMEOUT_MS,
  WEBAUTHN_CHALLENGE_TTL_MINUTES,
  WEBAUTHN_SUPPORTED_ALGORITHM_IDS,
  type SupportedLocale,
} from './policy.js';
import {
  isRecoveryEmailAttemptThrottled,
  isRecoveryOptionsGrantThrottled,
  isRecoveryRequestThrottled,
  isRecoveryVerificationGrantThrottled,
  recordRecoveryEmailFailedAttempt,
  recordRecoveryOptionsGrantAttempt,
  recordRecoveryRequestAttempt,
  recordRecoveryVerificationFailedAttempt,
} from './rate-limits.js';

type Db = Database['db'];

export type AccountRecoveryDeps = {
  env: Env;
  delivery: AccountRecoveryDeliveryAdapter;
  now: () => string;
  generateCode?: () => string;
  generateRecoveryToken?: () => string;
  generateId?: () => string;
};

export type RequestAccountRecoveryResult = {
  status: 'RECOVERY_REQUEST_ACCEPTED';
  /** Real challenge id when eligible; dummy UUID otherwise (anti-enumeration). */
  recoveryVerificationId: string;
};

export type VerifyRecoveryEmailSuccess = {
  status: 'RECOVERY_EMAIL_VERIFIED';
  recoveryGrant: string;
  recoveryGrantExpiresAt: string;
};

export class InvalidOrExpiredChallengeError extends Error {
  readonly code = 'INVALID_OR_EXPIRED_CHALLENGE';

  constructor() {
    super('The verification challenge is invalid or has expired.');
    this.name = 'InvalidOrExpiredChallengeError';
  }
}

export class RecoveryNotAuthorizedError extends Error {
  readonly code = 'RECOVERY_NOT_AUTHORIZED';
  readonly failureCategory: string;

  constructor(failureCategory = 'not_authorized') {
    super('Account recovery could not be completed.');
    this.name = 'RecoveryNotAuthorizedError';
    this.failureCategory = failureCategory;
  }
}

function resolveLocale(locale: string | undefined): SupportedLocale {
  if (locale !== undefined && isSupportedLocale(locale)) {
    return locale;
  }
  return 'en';
}

function toBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  throw new InvalidOrExpiredChallengeError();
}

function accountAlias(accountId: string): string {
  return `town-member-${accountId.replace(/-/g, '').slice(0, 12)}`;
}

function requireEnabledSecrets(env: Env): AccountRecoveryConfig {
  return requireAccountRecoveryConfig(env);
}

async function resolveAuthorizedRecovery(
  db: Db,
  config: AccountRecoveryConfig,
  input: { recoveryToken: string; now: string },
): Promise<{ grantId: string; accountId: string }> {
  const tokenHash = hashRecoveryGrantToken({
    hashKey: config.tokenHashKey,
    purpose: 'account_recovery',
    token: input.recoveryToken,
  });

  const grant = await findRecoveryGrantByTokenHash(db, tokenHash);
  if (!grant) {
    throw new RecoveryNotAuthorizedError('recovery_grant_unknown');
  }
  if (grant.consumedAt !== null) {
    throw new RecoveryNotAuthorizedError('recovery_grant_consumed');
  }
  if (grant.revokedAt !== null) {
    throw new RecoveryNotAuthorizedError('recovery_grant_revoked');
  }
  if (new Date(input.now).getTime() >= new Date(grant.expiresAt).getTime()) {
    throw new RecoveryNotAuthorizedError('recovery_grant_expired');
  }

  const account = await findAccountById(db, grant.accountId);
  if (!account) {
    throw new RecoveryNotAuthorizedError('account_missing');
  }
  if (account.status !== 'active') {
    throw new RecoveryNotAuthorizedError('account_wrong_state');
  }
  if (!account.webauthnUserHandle) {
    throw new RecoveryNotAuthorizedError('user_handle_missing');
  }

  const email = await findVerifiedPrimaryEmailForAccount(db, account.id);
  if (!email) {
    throw new RecoveryNotAuthorizedError('verified_email_missing');
  }

  return { grantId: grant.id, accountId: account.id };
}

export async function requestAccountRecovery(
  db: Db,
  deps: AccountRecoveryDeps,
  input: {
    email: string;
    locale?: string;
    ip: string;
    requestId?: string | null;
  },
): Promise<RequestAccountRecoveryResult> {
  const config = requireEnabledSecrets(deps.env);
  const now = deps.now();
  const generateId = deps.generateId ?? randomUUID;
  const generateCode = deps.generateCode ?? generateRecoveryCode;
  const locale = resolveLocale(input.locale);
  const emailOriginal = input.email.trim();
  const emailNormalized = normalizeEmail(emailOriginal);

  const throttled = await isRecoveryRequestThrottled(db, {
    rateLimitHashKey: config.rateLimitHashKey,
    emailNormalized,
    ip: input.ip,
    now,
  });
  await recordRecoveryRequestAttempt(db, {
    rateLimitHashKey: config.rateLimitHashKey,
    emailNormalized,
    ip: input.ip,
    now,
    throttled,
    ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
  });

  if (throttled) {
    return {
      status: 'RECOVERY_REQUEST_ACCEPTED',
      recoveryVerificationId: generateId(),
    };
  }

  const existingEmail = await findActiveEmailByNormalized(db, emailNormalized);
  let eligible = false;
  let accountId: string | null = null;

  if (existingEmail) {
    const account = await findAccountById(db, existingEmail.accountId);
    if (
      account?.status === 'active' &&
      existingEmail.isPrimary &&
      existingEmail.verifiedAt !== null
    ) {
      eligible = true;
      accountId = account.id;
    } else {
      accountId = existingEmail.accountId;
    }
  }

  if (!eligible || accountId === null) {
    const dummyId = generateId();
    const dummyCode = generateCode();
    hashRecoveryCode({
      hashKey: config.hashKey,
      challengeId: dummyId,
      purpose: 'recover_account',
      accountId: accountId ?? dummyId,
      code: dummyCode,
    });
    try {
      await deps.delivery.deliverRecoveryCode({
        email: emailOriginal,
        locale,
        code: dummyCode,
        expiresAt: addMinutes(now, ACCOUNT_RECOVERY_CODE_TTL_MINUTES),
        purpose: 'recover_account',
        outcomeCategory: 'suppressed',
        requestId: input.requestId ?? null,
      });
    } catch {
      // Delivery failures must not change the public accepted response.
    }
    if (accountId !== null) {
      await appendIdentitySecurityEvent(db, {
        id: generateId(),
        accountId,
        eventType: 'recovery_requested',
        occurredAt: now,
        requestId: input.requestId ?? null,
        metadata: {
          purpose: 'recover_account',
          deliveryOutcome: 'suppressed',
        },
      });
    }
    return {
      status: 'RECOVERY_REQUEST_ACCEPTED',
      recoveryVerificationId: dummyId,
    };
  }

  await revokeActiveEmailChallengesForSetup(db, {
    accountId,
    emailNormalized,
    purpose: 'recover_account',
    now,
  });

  const challengeId = generateId();
  const code = generateCode();
  const secretHash = hashRecoveryCode({
    hashKey: config.hashKey,
    challengeId,
    purpose: 'recover_account',
    accountId,
    code,
  });
  const expiresAt = addMinutes(now, ACCOUNT_RECOVERY_CODE_TTL_MINUTES);

  await createEmailChallenge(db, {
    id: challengeId,
    accountId,
    emailNormalized,
    purpose: 'recover_account',
    secretHash,
    createdAt: now,
    expiresAt,
  });

  let deliveryOutcome: 'recovery_code' | 'unavailable' = 'recovery_code';
  try {
    const delivery = await deps.delivery.deliverRecoveryCode({
      email: emailOriginal,
      locale,
      code,
      expiresAt,
      purpose: 'recover_account',
      outcomeCategory: 'recovery_code',
      requestId: input.requestId ?? null,
    });
    if (!delivery.delivered) {
      deliveryOutcome = 'unavailable';
    }
  } catch {
    deliveryOutcome = 'unavailable';
  }

  await appendIdentitySecurityEvent(db, {
    id: generateId(),
    accountId,
    eventType: 'recovery_requested',
    occurredAt: now,
    requestId: input.requestId ?? null,
    metadata: {
      purpose: 'recover_account',
      deliveryOutcome,
    },
  });

  return {
    status: 'RECOVERY_REQUEST_ACCEPTED',
    recoveryVerificationId: challengeId,
  };
}

export async function verifyRecoveryEmail(
  db: Db,
  deps: AccountRecoveryDeps,
  input: {
    recoveryVerificationId: string;
    code: string;
    ip: string;
    requestId?: string | null;
  },
): Promise<VerifyRecoveryEmailSuccess> {
  const config = requireEnabledSecrets(deps.env);
  const now = deps.now();
  const generateId = deps.generateId ?? randomUUID;
  const generateRecoveryToken = deps.generateRecoveryToken ?? generateRecoveryGrantToken;

  if (!/^\d{6}$/.test(input.code)) {
    throw new InvalidOrExpiredChallengeError();
  }

  type TxResult = { ok: true; value: VerifyRecoveryEmailSuccess } | { ok: false };

  let result: TxResult;
  try {
    result = await db.transaction(async (tx) => {
      const locked = await tx.execute<{
        id: string;
        account_id: string | null;
        email_normalized: string;
        purpose: string;
        secret_hash: unknown;
        expires_at: string;
        consumed_at: string | null;
        revoked_at: string | null;
        attempt_count: number;
      }>(sql`
        SELECT id, account_id, email_normalized, purpose, secret_hash, expires_at,
               consumed_at, revoked_at, attempt_count
        FROM town.email_challenges
        WHERE id = ${input.recoveryVerificationId}
        FOR UPDATE
      `);
      const challenge = locked.rows[0];
      if (!challenge) {
        return { ok: false };
      }
      if (challenge.purpose !== 'recover_account') {
        return { ok: false };
      }
      if (challenge.consumed_at !== null || challenge.revoked_at !== null) {
        return { ok: false };
      }
      if (new Date(now).getTime() >= new Date(challenge.expires_at).getTime()) {
        return { ok: false };
      }
      if (challenge.attempt_count >= ACCOUNT_RECOVERY_MAX_ATTEMPTS) {
        return { ok: false };
      }
      if (challenge.account_id === null) {
        return { ok: false };
      }

      const accountId = challenge.account_id;
      const emailNormalized = challenge.email_normalized;
      const dbTx = tx as unknown as Db;

      const attemptThrottled = await isRecoveryEmailAttemptThrottled(dbTx, {
        rateLimitHashKey: config.rateLimitHashKey,
        emailNormalized,
        ip: input.ip,
        challengeId: challenge.id,
        now,
      });
      if (attemptThrottled) {
        return { ok: false };
      }

      const accountRows = await tx.execute<{
        id: string;
        status: string;
      }>(sql`
        SELECT id, status FROM town.accounts WHERE id = ${accountId} FOR UPDATE
      `);
      const account = accountRows.rows[0];
      if (account?.status !== 'active') {
        return { ok: false };
      }

      const emailRows = await tx.execute<{
        id: string;
        is_primary: boolean;
        verified_at: string | null;
        revoked_at: string | null;
      }>(sql`
        SELECT id, is_primary, verified_at, revoked_at
        FROM town.account_emails
        WHERE account_id = ${accountId}
          AND email_normalized = ${emailNormalized}
          AND revoked_at IS NULL
        FOR UPDATE
      `);
      const email = emailRows.rows[0];
      if (email?.is_primary !== true || email.verified_at === null) {
        return { ok: false };
      }

      const codeOk = verifyRecoveryCode({
        hashKey: config.hashKey,
        challengeId: challenge.id,
        purpose: 'recover_account',
        accountId,
        code: input.code,
        expectedHash: toBuffer(challenge.secret_hash),
      });

      if (!codeOk) {
        await incrementEmailChallengeAttemptCount(dbTx, {
          challengeId: challenge.id,
        });
        await recordRecoveryEmailFailedAttempt(dbTx, {
          rateLimitHashKey: config.rateLimitHashKey,
          emailNormalized,
          ip: input.ip,
          challengeId: challenge.id,
          now,
          accountId,
          ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
        });
        return { ok: false };
      }

      const consumed = await tx
        .update(emailChallenges)
        .set({ consumedAt: now })
        .where(
          and(
            eq(emailChallenges.id, challenge.id),
            sql`${emailChallenges.consumedAt} is null`,
            sql`${emailChallenges.revokedAt} is null`,
          ),
        )
        .returning();
      if (!consumed[0]) {
        return { ok: false };
      }

      await revokeActiveEmailChallengesForSetup(dbTx, {
        accountId,
        emailNormalized,
        purpose: 'recover_account',
        now,
        excludeChallengeId: challenge.id,
      });
      await revokeActiveRecoveryGrantsForAccount(dbTx, {
        accountId,
        now,
      });

      const rawToken = generateRecoveryToken();
      const tokenHash = hashRecoveryGrantToken({
        hashKey: config.tokenHashKey,
        purpose: 'account_recovery',
        token: rawToken,
      });
      const grantExpiresAt = addMinutes(now, ACCOUNT_RECOVERY_GRANT_TTL_MINUTES);
      await createRecoveryGrant(dbTx, {
        id: generateId(),
        accountId,
        tokenHash,
        createdAt: now,
        expiresAt: grantExpiresAt,
      });

      await appendIdentitySecurityEvent(dbTx, {
        id: generateId(),
        accountId,
        eventType: 'recovery_email_verified',
        occurredAt: now,
        requestId: input.requestId ?? null,
        metadata: {
          purpose: 'recover_account',
          challengeState: 'consumed',
        },
      });

      return {
        ok: true as const,
        value: {
          status: 'RECOVERY_EMAIL_VERIFIED' as const,
          recoveryGrant: rawToken,
          recoveryGrantExpiresAt: grantExpiresAt,
        },
      };
    });
  } catch {
    throw new InvalidOrExpiredChallengeError();
  }

  if (!result.ok) {
    throw new InvalidOrExpiredChallengeError();
  }
  return result.value;
}

export async function createRecoveryPasskeyRegistrationOptions(
  db: Db,
  deps: AccountRecoveryDeps,
  input: {
    recoveryToken: string;
    requestId?: string | null;
  },
): Promise<{
  recoveryCeremonyId: string;
  options: Awaited<ReturnType<typeof generateRegistrationOptions>>;
}> {
  const config = requireEnabledSecrets(deps.env);
  const now = deps.now();
  const generateId = deps.generateId ?? (() => randomUUID());

  const { grantId, accountId } = await resolveAuthorizedRecovery(db, config, {
    recoveryToken: input.recoveryToken,
    now,
  });

  if (
    await isRecoveryOptionsGrantThrottled(db, {
      rateLimitHashKey: config.rateLimitHashKey,
      grantId,
      now,
    })
  ) {
    await recordRecoveryOptionsGrantAttempt(db, {
      rateLimitHashKey: config.rateLimitHashKey,
      grantId,
      accountId,
      now,
      throttled: true,
      requestId: input.requestId ?? null,
    });
    await revokeRecoveryGrant(db, { grantId, now }).catch(() => undefined);
    throw new RecoveryNotAuthorizedError('rate_limited_options');
  }

  const account = await findAccountById(db, accountId);
  if (!account?.webauthnUserHandle) {
    throw new RecoveryNotAuthorizedError('user_handle_missing');
  }
  const handle = Buffer.isBuffer(account.webauthnUserHandle)
    ? account.webauthnUserHandle
    : Buffer.from(account.webauthnUserHandle);

  const activePasskeys = await listActivePasskeys(db, accountId);
  const excludeCredentials = activePasskeys.map((credential) => {
    const idBytes = new Uint8Array(toBuffer(credential.credentialId));
    const descriptor: {
      id: string;
      transports?: AuthenticatorTransportFuture[];
    } = {
      id: isoBase64URL.fromBuffer(idBytes),
    };
    if (credential.transports && credential.transports.length > 0) {
      descriptor.transports = credential.transports as AuthenticatorTransportFuture[];
    }
    return descriptor;
  });

  const ceremonyId = generateId();
  const userName = accountAlias(accountId);
  const options = await generateRegistrationOptions({
    rpName: config.rpName,
    rpID: config.rpId,
    userName,
    userDisplayName: CIVIC_ACTOR_DISPLAY_LABEL,
    userID: new Uint8Array(handle),
    timeout: WEBAUTHN_CHALLENGE_TIMEOUT_MS,
    attestationType: 'none',
    excludeCredentials,
    authenticatorSelection: {
      residentKey: 'required',
      requireResidentKey: true,
      userVerification: 'required',
    },
    supportedAlgorithmIDs: [...WEBAUTHN_SUPPORTED_ALGORITHM_IDS],
  });

  const challengeHash = hashWebAuthnChallenge({
    hashKey: config.challengeHashKey,
    challengeId: ceremonyId,
    purpose: 'recover_register',
    accountId,
    rawChallenge: options.challenge,
  });
  const expiresAt = addMinutes(now, WEBAUTHN_CHALLENGE_TTL_MINUTES);

  await db.transaction(async (tx) => {
    const dbTx = tx as unknown as Db;
    const lockedAccount = await lockAccountById(dbTx, accountId);
    if (lockedAccount?.status !== 'active') {
      throw new RecoveryNotAuthorizedError('account_wrong_state');
    }
    await revokeActiveWebAuthnChallengesForAccount(dbTx, {
      accountId,
      purpose: 'recover_register',
      now,
    });
    await createWebAuthnChallenge(dbTx, {
      id: ceremonyId,
      accountId,
      purpose: 'recover_register',
      challengeHash,
      createdAt: now,
      expiresAt,
    });
  });

  await recordRecoveryOptionsGrantAttempt(db, {
    rateLimitHashKey: config.rateLimitHashKey,
    grantId,
    accountId,
    now,
    throttled: false,
    requestId: input.requestId ?? null,
  });

  return {
    recoveryCeremonyId: ceremonyId,
    options,
  };
}

export async function verifyRecoveryPasskeyRegistration(
  db: Db,
  deps: AccountRecoveryDeps,
  input: {
    recoveryToken: string;
    recoveryCeremonyId: string;
    response: RegistrationResponseJSON;
    requestId?: string | null;
  },
): Promise<{ status: 'RECOVERY_COMPLETE' }> {
  const config = requireEnabledSecrets(deps.env);
  const now = deps.now();
  const generateId = deps.generateId ?? (() => randomUUID());

  let grantId: string;
  let accountId: string;
  try {
    ({ grantId, accountId } = await resolveAuthorizedRecovery(db, config, {
      recoveryToken: input.recoveryToken,
      now,
    }));
  } catch (error) {
    if (error instanceof RecoveryNotAuthorizedError) {
      throw error;
    }
    throw new RecoveryNotAuthorizedError('recovery_grant_invalid');
  }

  if (
    await isRecoveryVerificationGrantThrottled(db, {
      rateLimitHashKey: config.rateLimitHashKey,
      grantId,
      now,
    })
  ) {
    await recordRecoveryVerificationFailedAttempt(db, {
      rateLimitHashKey: config.rateLimitHashKey,
      grantId,
      accountId,
      now,
      failureCategory: 'rate_limited_verify',
      requestId: input.requestId ?? null,
    });
    await revokeRecoveryGrant(db, { grantId, now }).catch(() => undefined);
    throw new RecoveryNotAuthorizedError('rate_limited_verify');
  }

  const failVerify = async (category: string): Promise<never> => {
    const count = await recordRecoveryVerificationFailedAttempt(db, {
      rateLimitHashKey: config.rateLimitHashKey,
      grantId,
      accountId,
      now,
      failureCategory: category,
      requestId: input.requestId ?? null,
    });
    await appendIdentitySecurityEvent(db, {
      id: generateId(),
      accountId,
      eventType: 'recovery_registration_failed',
      occurredAt: now,
      requestId: input.requestId ?? null,
      metadata: {
        purpose: 'recover_register',
        failureCategory: category,
      },
    }).catch(() => undefined);
    if (count >= 5) {
      await revokeRecoveryGrant(db, { grantId, now }).catch(() => undefined);
    }
    throw new RecoveryNotAuthorizedError(category);
  };

  const challengeRow = await findWebAuthnChallengeById(db, input.recoveryCeremonyId);
  if (!challengeRow) {
    return await failVerify('challenge_unknown');
  }
  if (challengeRow.accountId !== accountId) {
    return await failVerify('challenge_account_mismatch');
  }
  if (challengeRow.purpose !== 'recover_register') {
    return await failVerify('challenge_wrong_purpose');
  }
  if (challengeRow.consumedAt !== null) {
    return await failVerify('challenge_consumed');
  }
  if (challengeRow.revokedAt !== null) {
    return await failVerify('challenge_revoked');
  }
  if (new Date(now).getTime() >= new Date(challengeRow.expiresAt).getTime()) {
    return await failVerify('challenge_expired');
  }

  const account = await findAccountById(db, accountId);
  if (!account?.webauthnUserHandle) {
    return await failVerify('user_handle_missing');
  }
  const expectedHash = toBuffer(challengeRow.challengeHash);

  let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verification = await verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: (clientChallenge) =>
        verifyWebAuthnChallengeHash({
          hashKey: config.challengeHashKey,
          challengeId: challengeRow.id,
          purpose: 'recover_register',
          accountId,
          rawChallenge: clientChallenge,
          expectedHash,
        }),
      expectedOrigin: [...config.allowedOrigins],
      expectedRPID: config.rpId,
      requireUserVerification: true,
      supportedAlgorithmIDs: [...WEBAUTHN_SUPPORTED_ALGORITHM_IDS],
    });
  } catch {
    return await failVerify('webauthn_verify_failed');
  }

  if (!verification.verified) {
    return await failVerify('webauthn_not_verified');
  }
  const registrationInfo = verification.registrationInfo;
  if (!registrationInfo.userVerified) {
    return await failVerify('user_verification_missing');
  }

  const { credential, credentialDeviceType, credentialBackedUp, aaguid } = registrationInfo;
  if (!credential.id || credential.publicKey.byteLength === 0) {
    return await failVerify('credential_incomplete');
  }

  const credentialId = Buffer.from(isoBase64URL.toBuffer(credential.id));
  const publicKey = Buffer.from(credential.publicKey);
  const signCount = credential.counter;
  if (signCount < 0) {
    return await failVerify('invalid_sign_count');
  }

  const deviceType = null;
  const transports = credential.transports ?? null;
  const backedUp = credentialBackedUp;
  const backupEligible = credentialDeviceType === 'multiDevice';

  try {
    await db.transaction(async (tx) => {
      const dbTx = tx as unknown as Db;

      const grantLocked = await dbTx
        .select()
        .from(recoveryGrants)
        .where(eq(recoveryGrants.id, grantId))
        .limit(1)
        .for('update');
      const grant = grantLocked[0];
      if (
        grant?.consumedAt !== null ||
        grant.revokedAt !== null ||
        new Date(now).getTime() >= new Date(grant.expiresAt).getTime()
      ) {
        throw new RecoveryNotAuthorizedError('recovery_grant_invalid');
      }

      const lockedAccount = await lockAccountById(dbTx, accountId);
      if (lockedAccount?.status !== 'active') {
        throw new RecoveryNotAuthorizedError('account_wrong_state');
      }
      if (!lockedAccount.webauthnUserHandle) {
        throw new RecoveryNotAuthorizedError('user_handle_missing');
      }

      const email = await findVerifiedPrimaryEmailForAccount(dbTx, accountId, { forUpdate: true });
      if (!email) {
        throw new RecoveryNotAuthorizedError('verified_email_missing');
      }

      const challengeLocked = await dbTx
        .select()
        .from(webauthnChallenges)
        .where(eq(webauthnChallenges.id, challengeRow.id))
        .limit(1)
        .for('update');
      const lockedChallenge = challengeLocked[0];
      if (
        lockedChallenge?.accountId !== accountId ||
        lockedChallenge.purpose !== 'recover_register' ||
        lockedChallenge.consumedAt !== null ||
        lockedChallenge.revokedAt !== null ||
        new Date(now).getTime() >= new Date(lockedChallenge.expiresAt).getTime()
      ) {
        throw new RecoveryNotAuthorizedError('challenge_invalid');
      }

      const clientData = JSON.parse(
        Buffer.from(isoBase64URL.toBuffer(input.response.response.clientDataJSON)).toString('utf8'),
      ) as { challenge?: string };
      if (
        typeof clientData.challenge !== 'string' ||
        !verifyWebAuthnChallengeHash({
          hashKey: config.challengeHashKey,
          challengeId: lockedChallenge.id,
          purpose: 'recover_register',
          accountId,
          rawChallenge: clientData.challenge,
          expectedHash: toBuffer(lockedChallenge.challengeHash),
        })
      ) {
        throw new RecoveryNotAuthorizedError('challenge_mismatch');
      }

      await addPasskeyCredential(dbTx, {
        id: generateId(),
        accountId,
        credentialId,
        publicKey,
        signCount,
        transports,
        deviceType,
        backedUp,
        backupEligible,
        aaguid: aaguid && aaguid !== '00000000-0000-0000-0000-000000000000' ? aaguid : null,
        label: null,
        createdAt: now,
      });

      const consumedChallenge = await dbTx
        .update(webauthnChallenges)
        .set({ consumedAt: now })
        .where(
          and(
            eq(webauthnChallenges.id, lockedChallenge.id),
            isNull(webauthnChallenges.consumedAt),
            isNull(webauthnChallenges.revokedAt),
            gt(webauthnChallenges.expiresAt, now),
          ),
        )
        .returning();
      if (!consumedChallenge[0]) {
        throw new RecoveryNotAuthorizedError('challenge_consume_failed');
      }

      await consumeRecoveryGrant(dbTx, {
        grantId,
        now,
      });

      await revokeActiveWebAuthnChallengesForAccount(dbTx, {
        accountId,
        purpose: 'recover_register',
        now,
        excludeChallengeId: lockedChallenge.id,
      });
      await revokeActiveEmailChallengesForSetup(dbTx, {
        accountId,
        emailNormalized: email.emailNormalized,
        purpose: 'recover_account',
        now,
      });
      await revokeActiveRecoveryGrantsForAccount(dbTx, {
        accountId,
        now,
        excludeGrantId: grantId,
      });

      await revokeAllAccountSessions(dbTx, {
        accountId,
        reason: 'recovery_completed',
        now,
        eventId: generateId(),
        requestId: input.requestId ?? null,
      });

      await setAccountRecoveryCompletedAt(dbTx, {
        accountId,
        recoveryCompletedAt: now,
        updatedAt: now,
      });

      await appendIdentitySecurityEvent(dbTx, {
        id: generateId(),
        accountId,
        eventType: 'passkey_registered',
        occurredAt: now,
        requestId: input.requestId ?? null,
        metadata: {
          purpose: 'recover_register',
          backupState: backedUp ? 'backed_up' : 'not_backed_up',
        },
      });
      await appendIdentitySecurityEvent(dbTx, {
        id: generateId(),
        accountId,
        eventType: 'recovery_completed',
        occurredAt: now,
        requestId: input.requestId ?? null,
        metadata: {
          purpose: 'recover_register',
          grantId,
        },
      });
    });
  } catch (error) {
    if (error instanceof RecoveryNotAuthorizedError) {
      await failVerify(error.failureCategory);
    }
    const message = error instanceof Error ? error.message : '';
    if (/DUPLICATE_CREDENTIAL_ID|passkey_credentials_credential_id_unique/i.test(message)) {
      await failVerify('duplicate_credential');
    }
    await failVerify('completion_failed');
  }

  return { status: 'RECOVERY_COMPLETE' };
}

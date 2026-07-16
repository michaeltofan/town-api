import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { Env } from '../../config/env.js';
import type { Database } from '../../db/client.js';
import { emailChallenges } from '../../db/schema.js';
import { normalizeEmail } from '../../identity/email-normalize.js';
import {
  createAccountShell,
  findAccountById,
  transitionAccountState,
} from '../../identity/repositories/accounts.js';
import {
  createEmailChallenge,
  findLatestEmailChallengeForSetup,
  incrementEmailChallengeAttemptCount,
  revokeActiveEmailChallengesForSetup,
} from '../../identity/repositories/challenges.js';
import {
  addAccountEmail,
  findActiveEmailByNormalized,
  verifyEmail,
} from '../../identity/repositories/emails.js';
import { appendIdentitySecurityEvent } from '../../identity/repositories/security-events.js';
import { addMinutes, computeSetupGrantExpiresAt } from '../policy.js';
import {
  createSetupGrant,
  revokeActiveSetupGrantsForAccount,
} from '../repositories/setup-grants.js';
import {
  generateSetupGrantToken,
  generateVerificationCode,
  hashOpaqueToken,
  hashVerificationCode,
  verifyVerificationCode,
} from './crypto.js';
import type { EmailVerificationDeliveryAdapter } from './delivery.js';
import {
  EMAIL_VERIFICATION_CODE_TTL_MINUTES,
  EMAIL_VERIFICATION_DELIVERY_COOLDOWN_SECONDS,
  EMAIL_VERIFICATION_MAX_ATTEMPTS,
  isSupportedLocale,
  type SupportedLocale,
} from './policy.js';
import {
  isEmailVerificationAttemptThrottled,
  isEmailVerificationRequestThrottled,
  recordEmailVerificationFailedAttempt,
  recordEmailVerificationRequestAttempt,
} from './rate-limits.js';

type Db = Database['db'];

export type EmailVerificationDeps = {
  env: Env;
  delivery: EmailVerificationDeliveryAdapter;
  now: () => string;
  generateCode?: () => string;
  generateSetupToken?: () => string;
  generateId?: () => string;
};

export type RequestVerificationResult = {
  status: 'VERIFICATION_REQUEST_ACCEPTED';
};

export type CompleteVerificationSuccess = {
  status: 'EMAIL_VERIFIED';
  setupGrant: string;
  setupGrantExpiresAt: string;
};

export class InvalidOrExpiredChallengeError extends Error {
  readonly code = 'INVALID_OR_EXPIRED_CHALLENGE';

  constructor() {
    super('The verification challenge is invalid or has expired.');
    this.name = 'InvalidOrExpiredChallengeError';
  }
}

function requireEnabledSecrets(env: Env): {
  hashKey: string;
  rateLimitHashKey: string;
} {
  const hashKey = env.EMAIL_VERIFICATION_HASH_KEY;
  const rateLimitHashKey = env.CEREMONY_RATE_LIMIT_HASH_KEY;
  if (!hashKey || !rateLimitHashKey) {
    throw new Error('Email verification secrets are not configured');
  }
  return { hashKey, rateLimitHashKey };
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

async function ensurePendingEmailAccount(
  db: Db,
  input: {
    emailOriginal: string;
    emailNormalized: string;
    now: string;
    generateId: () => string;
  },
): Promise<{ accountId: string; emailId: string }> {
  const existing = await findActiveEmailByNormalized(db, input.emailNormalized);
  if (existing) {
    return { accountId: existing.accountId, emailId: existing.id };
  }

  const accountId = input.generateId();
  const emailId = input.generateId();
  try {
    await createAccountShell(db, {
      id: accountId,
      createdAt: input.now,
      updatedAt: input.now,
    });
    await addAccountEmail(db, {
      id: emailId,
      accountId,
      email: input.emailOriginal,
      isPrimary: true,
      createdAt: input.now,
      updatedAt: input.now,
    });
    return { accountId, emailId };
  } catch {
    const raced = await findActiveEmailByNormalized(db, input.emailNormalized);
    if (!raced) {
      throw new Error('Failed to create or locate account email');
    }
    return { accountId: raced.accountId, emailId: raced.id };
  }
}

export async function requestEmailVerification(
  db: Db,
  deps: EmailVerificationDeps,
  input: {
    email: string;
    locale?: string;
    ip: string;
    requestId?: string | null;
  },
): Promise<RequestVerificationResult> {
  const { hashKey, rateLimitHashKey } = requireEnabledSecrets(deps.env);
  const now = deps.now();
  const generateId = deps.generateId ?? randomUUID;
  const generateCode = deps.generateCode ?? generateVerificationCode;
  const locale = resolveLocale(input.locale);
  const emailOriginal = input.email.trim();
  const emailNormalized = normalizeEmail(emailOriginal);

  const throttled = await isEmailVerificationRequestThrottled(db, {
    rateLimitHashKey,
    emailNormalized,
    ip: input.ip,
    now,
  });
  await recordEmailVerificationRequestAttempt(db, {
    rateLimitHashKey,
    emailNormalized,
    ip: input.ip,
    now,
    throttled,
    ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
  });

  const accepted: RequestVerificationResult = { status: 'VERIFICATION_REQUEST_ACCEPTED' };

  if (throttled) {
    return accepted;
  }

  const existingEmail = await findActiveEmailByNormalized(db, emailNormalized);
  let accountId: string;
  let accountStatus: string;

  if (existingEmail) {
    accountId = existingEmail.accountId;
    const account = await findAccountById(db, existingEmail.accountId);
    accountStatus = account?.status ?? 'unavailable';
  } else {
    const created = await ensurePendingEmailAccount(db, {
      emailOriginal,
      emailNormalized,
      now,
      generateId,
    });
    accountId = created.accountId;
    accountStatus = 'pending_email';
  }

  if (
    accountStatus === 'suspended' ||
    accountStatus === 'closed' ||
    accountStatus === 'active' ||
    accountStatus === 'pending_passkey' ||
    accountStatus === 'unavailable'
  ) {
    const outcomeCategory =
      accountStatus === 'active' || accountStatus === 'pending_passkey'
        ? 'existing_account_guidance'
        : 'suppressed';
    const dummyId = generateId();
    const dummyCode = generateCode();
    hashVerificationCode({
      hashKey,
      challengeId: dummyId,
      purpose: 'verify_email',
      code: dummyCode,
    });
    try {
      await deps.delivery.deliverVerificationCode({
        email: emailOriginal,
        locale,
        code: dummyCode,
        expiresAt: addMinutes(now, EMAIL_VERIFICATION_CODE_TTL_MINUTES),
        purpose: 'verify_email',
        outcomeCategory,
      });
    } catch {
      // Delivery failures must not change the public accepted response.
    }
    await appendIdentitySecurityEvent(db, {
      id: generateId(),
      accountId,
      eventType: 'email_verification_requested',
      occurredAt: now,
      requestId: input.requestId ?? null,
      metadata: {
        purpose: 'verify_email',
        deliveryOutcome: outcomeCategory,
      },
    });
    return accepted;
  }

  const latest = await findLatestEmailChallengeForSetup(db, {
    accountId,
    emailNormalized,
    purpose: 'verify_email',
  });
  if (latest) {
    const elapsedMs = new Date(now).getTime() - new Date(latest.createdAt).getTime();
    if (elapsedMs < EMAIL_VERIFICATION_DELIVERY_COOLDOWN_SECONDS * 1000) {
      await appendIdentitySecurityEvent(db, {
        id: generateId(),
        accountId,
        eventType: 'email_verification_requested',
        occurredAt: now,
        requestId: input.requestId ?? null,
        metadata: {
          purpose: 'verify_email',
          deliveryOutcome: 'suppressed',
        },
      });
      return accepted;
    }
  }

  await revokeActiveEmailChallengesForSetup(db, {
    accountId,
    emailNormalized,
    purpose: 'verify_email',
    now,
  });

  const challengeId = generateId();
  const code = generateCode();
  const secretHash = hashVerificationCode({
    hashKey,
    challengeId,
    purpose: 'verify_email',
    code,
  });
  const expiresAt = addMinutes(now, EMAIL_VERIFICATION_CODE_TTL_MINUTES);

  await createEmailChallenge(db, {
    id: challengeId,
    accountId,
    emailNormalized,
    purpose: 'verify_email',
    secretHash,
    createdAt: now,
    expiresAt,
  });

  let deliveryOutcome: 'verification_code' | 'unavailable' = 'verification_code';
  try {
    const delivery = await deps.delivery.deliverVerificationCode({
      email: emailOriginal,
      locale,
      code,
      expiresAt,
      purpose: 'verify_email',
      outcomeCategory: 'verification_code',
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
    eventType: 'email_verification_requested',
    occurredAt: now,
    requestId: input.requestId ?? null,
    metadata: {
      purpose: 'verify_email',
      deliveryOutcome,
    },
  });

  return accepted;
}

export async function completeEmailVerification(
  db: Db,
  deps: EmailVerificationDeps,
  input: {
    verificationId: string;
    code: string;
    ip: string;
    requestId?: string | null;
  },
): Promise<CompleteVerificationSuccess> {
  const { hashKey, rateLimitHashKey } = requireEnabledSecrets(deps.env);
  const now = deps.now();
  const generateId = deps.generateId ?? randomUUID;
  const generateSetupToken = deps.generateSetupToken ?? generateSetupGrantToken;

  if (!/^\d{6}$/.test(input.code)) {
    throw new InvalidOrExpiredChallengeError();
  }

  type TxResult = { ok: true; value: CompleteVerificationSuccess } | { ok: false };

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
        WHERE id = ${input.verificationId}
        FOR UPDATE
      `);
      const challenge = locked.rows[0];
      if (!challenge) {
        return { ok: false };
      }
      if (challenge.purpose !== 'verify_email') {
        return { ok: false };
      }
      if (challenge.consumed_at !== null || challenge.revoked_at !== null) {
        return { ok: false };
      }
      if (new Date(now).getTime() >= new Date(challenge.expires_at).getTime()) {
        return { ok: false };
      }
      if (challenge.attempt_count >= EMAIL_VERIFICATION_MAX_ATTEMPTS) {
        return { ok: false };
      }
      if (challenge.account_id === null) {
        return { ok: false };
      }

      const accountId = challenge.account_id;
      const emailNormalized = challenge.email_normalized;
      const dbTx = tx as unknown as Db;

      const attemptThrottled = await isEmailVerificationAttemptThrottled(dbTx, {
        rateLimitHashKey,
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
      if (account?.status !== 'pending_email') {
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
      if (email?.is_primary !== true || email.verified_at !== null) {
        return { ok: false };
      }

      const codeOk = verifyVerificationCode({
        hashKey,
        challengeId: challenge.id,
        purpose: 'verify_email',
        code: input.code,
        expectedHash: toBuffer(challenge.secret_hash),
      });

      if (!codeOk) {
        await incrementEmailChallengeAttemptCount(dbTx, {
          challengeId: challenge.id,
        });
        await recordEmailVerificationFailedAttempt(dbTx, {
          rateLimitHashKey,
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

      await verifyEmail(dbTx, { emailId: email.id, verifiedAt: now });
      await transitionAccountState(dbTx, {
        accountId,
        to: 'pending_passkey',
        at: now,
      });
      await revokeActiveEmailChallengesForSetup(dbTx, {
        accountId,
        emailNormalized,
        purpose: 'verify_email',
        now,
        excludeChallengeId: challenge.id,
      });
      await revokeActiveSetupGrantsForAccount(dbTx, {
        accountId,
        purpose: 'initial_passkey_registration',
        now,
      });

      const rawToken = generateSetupToken();
      const tokenHash = hashOpaqueToken({
        hashKey,
        purpose: 'initial_passkey_registration',
        token: rawToken,
      });
      const grantExpiresAt = computeSetupGrantExpiresAt(now);
      await createSetupGrant(dbTx, {
        id: generateId(),
        accountId,
        tokenHash,
        purpose: 'initial_passkey_registration',
        createdAt: now,
        expiresAt: grantExpiresAt,
      });

      await appendIdentitySecurityEvent(dbTx, {
        id: generateId(),
        accountId,
        eventType: 'email_verified',
        occurredAt: now,
        requestId: input.requestId ?? null,
        metadata: {
          purpose: 'verify_email',
          challengeState: 'consumed',
        },
      });

      return {
        ok: true as const,
        value: {
          status: 'EMAIL_VERIFIED' as const,
          setupGrant: rawToken,
          setupGrantExpiresAt: grantExpiresAt,
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

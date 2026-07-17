import { randomUUID } from 'node:crypto';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Env } from '../../config/env.js';
import type { Database } from '../../db/client.js';
import { setupGrants, webauthnChallenges } from '../../db/schema.js';
import {
  ensureWebAuthnUserHandle,
  findAccountById,
  lockAccountById,
  transitionAccountState,
} from '../../identity/repositories/accounts.js';
import { createCivicActor, linkActorToAccount } from '../../identity/repositories/actor-link.js';
import {
  createWebAuthnChallenge,
  findWebAuthnChallengeById,
  revokeActiveWebAuthnChallengesForAccount,
} from '../../identity/repositories/challenges.js';
import { findVerifiedPrimaryEmailForAccount } from '../../identity/repositories/emails.js';
import { addPasskeyCredential, listActivePasskeys } from '../../identity/repositories/passkeys.js';
import { appendIdentitySecurityEvent } from '../../identity/repositories/security-events.js';
import { addMinutes } from '../policy.js';
import { consumeSetupGrant, revokeSetupGrant } from '../repositories/setup-grants.js';
import { hashOpaqueToken } from '../email-verification/crypto.js';
import { requireWebAuthnRegistrationConfig, type WebAuthnRegistrationConfig } from './config.js';
import {
  generateWebAuthnUserHandle,
  hashWebAuthnChallenge,
  verifyWebAuthnChallengeHash,
} from './crypto.js';
import {
  CIVIC_ACTOR_DISPLAY_LABEL,
  WEBAUTHN_CHALLENGE_TIMEOUT_MS,
  WEBAUTHN_CHALLENGE_TTL_MINUTES,
  WEBAUTHN_SUPPORTED_ALGORITHM_IDS,
} from './policy.js';
import {
  isSetupOptionsGrantThrottled,
  isSetupVerificationGrantThrottled,
  recordSetupOptionsGrantAttempt,
  recordSetupVerificationFailedAttempt,
} from './rate-limits.js';

type Db = Database['db'];

export type PasskeyRegistrationDeps = {
  env: Env;
  now: () => string;
  generateId?: () => string;
  generateUserHandle?: () => Buffer;
};

export class PasskeyRegistrationFailedError extends Error {
  readonly code = 'PASSKEY_REGISTRATION_FAILED';
  readonly failureCategory: string;

  constructor(failureCategory: string) {
    super('Passkey registration could not be completed.');
    this.name = 'PasskeyRegistrationFailedError';
    this.failureCategory = failureCategory;
  }
}

function toBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  throw new PasskeyRegistrationFailedError('invalid_buffer');
}

function accountAlias(accountId: string): string {
  // Bounded non-sensitive server alias; avoids email and full UUID exposure.
  return `town-member-${accountId.replace(/-/g, '').slice(0, 12)}`;
}

async function resolveAuthorizedSetup(
  db: Db,
  config: WebAuthnRegistrationConfig,
  input: { setupToken: string; now: string },
): Promise<{ grantId: string; accountId: string }> {
  const tokenHash = hashOpaqueToken({
    hashKey: config.setupGrantHashKey,
    purpose: 'initial_passkey_registration',
    token: input.setupToken,
  });

  const grantRows = await db
    .select()
    .from(setupGrants)
    .where(eq(setupGrants.tokenHash, tokenHash))
    .limit(1);
  const grant = grantRows[0];
  if (!grant) {
    throw new PasskeyRegistrationFailedError('setup_grant_unknown');
  }
  if (grant.purpose !== 'initial_passkey_registration') {
    throw new PasskeyRegistrationFailedError('setup_grant_wrong_purpose');
  }
  if (grant.consumedAt !== null) {
    throw new PasskeyRegistrationFailedError('setup_grant_consumed');
  }
  if (grant.revokedAt !== null) {
    throw new PasskeyRegistrationFailedError('setup_grant_revoked');
  }
  if (new Date(input.now).getTime() >= new Date(grant.expiresAt).getTime()) {
    throw new PasskeyRegistrationFailedError('setup_grant_expired');
  }

  const account = await findAccountById(db, grant.accountId);
  if (!account) {
    throw new PasskeyRegistrationFailedError('account_missing');
  }
  if (account.status !== 'pending_passkey') {
    throw new PasskeyRegistrationFailedError('account_wrong_state');
  }

  const email = await findVerifiedPrimaryEmailForAccount(db, account.id);
  if (!email) {
    throw new PasskeyRegistrationFailedError('verified_email_missing');
  }

  return { grantId: grant.id, accountId: account.id };
}

export async function createPasskeyRegistrationOptions(
  db: Db,
  deps: PasskeyRegistrationDeps,
  input: {
    setupToken: string;
    requestId?: string | null;
  },
): Promise<{
  registrationCeremonyId: string;
  options: Awaited<ReturnType<typeof generateRegistrationOptions>>;
}> {
  const config = requireWebAuthnRegistrationConfig(deps.env);
  const now = deps.now();
  const generateId = deps.generateId ?? (() => randomUUID());
  const generateUserHandle = deps.generateUserHandle ?? generateWebAuthnUserHandle;

  const { grantId, accountId } = await resolveAuthorizedSetup(db, config, {
    setupToken: input.setupToken,
    now,
  });

  if (
    await isSetupOptionsGrantThrottled(db, {
      rateLimitHashKey: config.rateLimitHashKey,
      grantId,
      now,
    })
  ) {
    await recordSetupOptionsGrantAttempt(db, {
      rateLimitHashKey: config.rateLimitHashKey,
      grantId,
      accountId,
      now,
      throttled: true,
      requestId: input.requestId ?? null,
    });
    await revokeSetupGrant(db, { grantId, now }).catch(() => undefined);
    throw new PasskeyRegistrationFailedError('rate_limited_options');
  }

  const handle = await ensureWebAuthnUserHandle(db, {
    accountId,
    handle: generateUserHandle(),
    now,
  });

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
    purpose: 'register',
    accountId,
    rawChallenge: options.challenge,
  });
  const expiresAt = addMinutes(now, WEBAUTHN_CHALLENGE_TTL_MINUTES);

  await db.transaction(async (tx) => {
    const dbTx = tx as unknown as Db;
    const lockedAccount = await lockAccountById(dbTx, accountId);
    if (lockedAccount?.status !== 'pending_passkey') {
      throw new PasskeyRegistrationFailedError('account_wrong_state');
    }
    await revokeActiveWebAuthnChallengesForAccount(dbTx, {
      accountId,
      purpose: 'register',
      now,
    });
    await createWebAuthnChallenge(dbTx, {
      id: ceremonyId,
      accountId,
      purpose: 'register',
      challengeHash,
      createdAt: now,
      expiresAt,
    });
  });

  await recordSetupOptionsGrantAttempt(db, {
    rateLimitHashKey: config.rateLimitHashKey,
    grantId,
    accountId,
    now,
    throttled: false,
    requestId: input.requestId ?? null,
  });

  return {
    registrationCeremonyId: ceremonyId,
    options,
  };
}

export async function verifyPasskeyRegistration(
  db: Db,
  deps: PasskeyRegistrationDeps,
  input: {
    setupToken: string;
    registrationCeremonyId: string;
    response: RegistrationResponseJSON;
    requestId?: string | null;
  },
): Promise<{ status: 'ACCOUNT_READY' }> {
  const config = requireWebAuthnRegistrationConfig(deps.env);
  const now = deps.now();
  const generateId = deps.generateId ?? (() => randomUUID());

  let grantId: string;
  let accountId: string;
  try {
    ({ grantId, accountId } = await resolveAuthorizedSetup(db, config, {
      setupToken: input.setupToken,
      now,
    }));
  } catch (error) {
    if (error instanceof PasskeyRegistrationFailedError) {
      throw error;
    }
    throw new PasskeyRegistrationFailedError('setup_grant_invalid');
  }

  if (
    await isSetupVerificationGrantThrottled(db, {
      rateLimitHashKey: config.rateLimitHashKey,
      grantId,
      now,
    })
  ) {
    await recordSetupVerificationFailedAttempt(db, {
      rateLimitHashKey: config.rateLimitHashKey,
      grantId,
      accountId,
      now,
      failureCategory: 'rate_limited_verify',
      requestId: input.requestId ?? null,
    });
    await revokeSetupGrant(db, { grantId, now }).catch(() => undefined);
    throw new PasskeyRegistrationFailedError('rate_limited_verify');
  }

  const failVerify = async (category: string): Promise<never> => {
    const count = await recordSetupVerificationFailedAttempt(db, {
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
      eventType: 'passkey_registration_failed',
      occurredAt: now,
      requestId: input.requestId ?? null,
      metadata: {
        purpose: 'register',
        failureCategory: category,
      },
    }).catch(() => undefined);
    if (count >= 5) {
      await revokeSetupGrant(db, { grantId, now }).catch(() => undefined);
    }
    throw new PasskeyRegistrationFailedError(category);
  };

  const challengeRow = await findWebAuthnChallengeById(db, input.registrationCeremonyId);
  if (!challengeRow) {
    return await failVerify('challenge_unknown');
  }
  if (challengeRow.accountId !== accountId) {
    return await failVerify('challenge_account_mismatch');
  }
  if (challengeRow.purpose !== 'register') {
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
          purpose: 'register',
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

  // device_type column accepts platform|cross_platform; library returns single/multi device.
  // Persist null unless a supported mapping exists (none for this library version).
  const deviceType = null;
  const transports = credential.transports ?? null;
  const backedUp = credentialBackedUp;
  const backupEligible = credentialDeviceType === 'multiDevice';

  try {
    await db.transaction(async (tx) => {
      const dbTx = tx as unknown as Db;

      const grantLocked = await dbTx
        .select()
        .from(setupGrants)
        .where(eq(setupGrants.id, grantId))
        .limit(1)
        .for('update');
      const grant = grantLocked[0];
      if (
        grant?.purpose !== 'initial_passkey_registration' ||
        grant.consumedAt !== null ||
        grant.revokedAt !== null ||
        new Date(now).getTime() >= new Date(grant.expiresAt).getTime()
      ) {
        throw new PasskeyRegistrationFailedError('setup_grant_invalid');
      }

      const lockedAccount = await lockAccountById(dbTx, accountId);
      if (lockedAccount?.status !== 'pending_passkey') {
        throw new PasskeyRegistrationFailedError('account_wrong_state');
      }
      if (!lockedAccount.webauthnUserHandle) {
        throw new PasskeyRegistrationFailedError('user_handle_missing');
      }

      const email = await findVerifiedPrimaryEmailForAccount(dbTx, accountId, { forUpdate: true });
      if (!email) {
        throw new PasskeyRegistrationFailedError('verified_email_missing');
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
        lockedChallenge.purpose !== 'register' ||
        lockedChallenge.consumedAt !== null ||
        lockedChallenge.revokedAt !== null ||
        new Date(now).getTime() >= new Date(lockedChallenge.expiresAt).getTime()
      ) {
        throw new PasskeyRegistrationFailedError('challenge_invalid');
      }

      // Confirm response challenge still binds to the locked ceremony hash.
      const clientData = JSON.parse(
        Buffer.from(isoBase64URL.toBuffer(input.response.response.clientDataJSON)).toString('utf8'),
      ) as { challenge?: string };
      if (
        typeof clientData.challenge !== 'string' ||
        !verifyWebAuthnChallengeHash({
          hashKey: config.challengeHashKey,
          challengeId: lockedChallenge.id,
          purpose: 'register',
          accountId,
          rawChallenge: clientData.challenge,
          expectedHash: toBuffer(lockedChallenge.challengeHash),
        })
      ) {
        throw new PasskeyRegistrationFailedError('challenge_mismatch');
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

      const actorId = generateId();
      await createCivicActor(dbTx, {
        id: actorId,
        displayLabel: CIVIC_ACTOR_DISPLAY_LABEL,
        communityId: null,
        createdAt: now,
        updatedAt: now,
      });
      await linkActorToAccount(dbTx, { actorId, accountId, at: now });

      await transitionAccountState(dbTx, {
        accountId,
        to: 'active',
        at: now,
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
        throw new PasskeyRegistrationFailedError('challenge_consume_failed');
      }

      await consumeSetupGrant(dbTx, {
        grantId,
        accountId,
        purpose: 'initial_passkey_registration',
        now,
      });

      await revokeActiveWebAuthnChallengesForAccount(dbTx, {
        accountId,
        purpose: 'register',
        now,
        excludeChallengeId: lockedChallenge.id,
      });

      await appendIdentitySecurityEvent(dbTx, {
        id: generateId(),
        accountId,
        eventType: 'passkey_registered',
        occurredAt: now,
        requestId: input.requestId ?? null,
        metadata: {
          purpose: 'register',
          backupState: backedUp ? 'backed_up' : 'not_backed_up',
        },
      });
      await appendIdentitySecurityEvent(dbTx, {
        id: generateId(),
        accountId,
        eventType: 'account_activated',
        occurredAt: now,
        requestId: input.requestId ?? null,
        metadata: {
          purpose: 'register',
        },
      });
    });
  } catch (error) {
    if (error instanceof PasskeyRegistrationFailedError) {
      await failVerify(error.failureCategory);
    }
    const message = error instanceof Error ? error.message : '';
    if (/DUPLICATE_CREDENTIAL_ID|passkey_credentials_credential_id_unique/i.test(message)) {
      await failVerify('duplicate_credential');
    }
    await failVerify('activation_failed');
  }

  return { status: 'ACCOUNT_READY' };
}

/** Test/diagnostic helper — not a public route. */
export async function countActiveRegisterChallenges(
  db: Db,
  accountId: string,
  now: string,
): Promise<number> {
  const rows = await db
    .select()
    .from(webauthnChallenges)
    .where(
      and(
        eq(webauthnChallenges.accountId, accountId),
        eq(webauthnChallenges.purpose, 'register'),
        isNull(webauthnChallenges.consumedAt),
        isNull(webauthnChallenges.revokedAt),
        gt(webauthnChallenges.expiresAt, now),
      ),
    );
  return rows.length;
}

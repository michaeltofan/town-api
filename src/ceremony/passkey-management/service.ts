import { randomUUID } from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Env } from '../../config/env.js';
import type { Database } from '../../db/client.js';
import {
  passkeyCredentials,
  webauthnChallenges,
  type AccountSessionClientType,
  type AccountSessionRow,
  type PasskeyCredentialRow,
} from '../../db/schema.js';
import { findAccountById, lockAccountById } from '../../identity/repositories/accounts.js';
import {
  createWebAuthnChallenge,
  findWebAuthnChallengeById,
  revokeActiveWebAuthnChallengesForSession,
} from '../../identity/repositories/challenges.js';
import {
  addPasskeyCredential,
  findActivePasskeyByCredentialId,
  findActivePasskeyByPublicId,
  listActivePasskeys,
  revokePasskey,
  updatePasskeyAuthenticationState,
  updatePasskeyLabel,
} from '../../identity/repositories/passkeys.js';
import { appendIdentitySecurityEvent } from '../../identity/repositories/security-events.js';
import { IdentityInvariantError } from '../../identity/errors.js';
import { addMinutes } from '../policy.js';
import { generateSessionToken, hashSessionToken } from '../passkey-authentication/crypto.js';
import {
  hashManageWebAuthnChallenge,
  verifyManageWebAuthnChallengeHash,
} from '../passkey-registration/crypto.js';
import {
  rotateAccountSessionTx,
  revokeAllOtherAccountSessions,
} from '../repositories/account-sessions.js';
import { requirePasskeyManagementConfig } from './config.js';
import { InvalidPasskeyLabelError, normalizeLabel } from './labels.js';
import {
  CIVIC_ACTOR_DISPLAY_LABEL,
  MANAGE_PASSKEYS_CHALLENGE_TTL_MINUTES,
  MANAGE_PASSKEYS_TIMEOUT_MS,
  PASSKEY_FRESHNESS_MINUTES,
  WEBAUTHN_SUPPORTED_ALGORITHM_IDS,
} from './policy.js';
import {
  isManageReauthOptionsThrottled,
  isManageReauthVerifyThrottled,
  isManageRegisterOptionsThrottled,
  isManageRegisterVerifyThrottled,
  isPasskeyInventoryThrottled,
  isPasskeyRenameThrottled,
  isPasskeyRevokeThrottled,
  recordManageReauthOptionsAttempt,
  recordManageReauthVerifyFailedAttempt,
  recordManageRegisterOptionsAttempt,
  recordManageRegisterVerifyFailedAttempt,
  recordPasskeyInventoryAttempt,
  recordPasskeyRenameAttempt,
  recordPasskeyRevokeAttempt,
} from './rate-limits.js';

type Db = Database['db'];

export type PasskeyManagementDeps = {
  env: Env;
  now: () => string;
  generateId?: () => string;
  generateToken?: () => string;
};

export class SessionNotAuthorizedError extends Error {
  readonly code = 'SESSION_NOT_AUTHORIZED';
  constructor() {
    super('Session is not authorized.');
    this.name = 'SessionNotAuthorizedError';
  }
}

export class FreshAuthenticationRequiredError extends Error {
  readonly code = 'FRESH_AUTHENTICATION_REQUIRED';
  constructor() {
    super('Fresh authentication is required.');
    this.name = 'FreshAuthenticationRequiredError';
  }
}

export class PasskeyNotFoundError extends Error {
  readonly code = 'PASSKEY_NOT_FOUND';
  constructor() {
    super('Passkey was not found.');
    this.name = 'PasskeyNotFoundError';
  }
}

export class PasskeyRegistrationFailedError extends Error {
  readonly code = 'PASSKEY_REGISTRATION_FAILED';
  readonly failureCategory: string;
  constructor(failureCategory: string) {
    super('Passkey registration could not be completed.');
    this.name = 'PasskeyRegistrationFailedError';
    this.failureCategory = failureCategory;
  }
}

export class PasskeyReauthenticationFailedError extends Error {
  readonly code = 'PASSKEY_REAUTHENTICATION_FAILED';
  readonly failureCategory: string;
  constructor(failureCategory: string) {
    super('Passkey reauthentication could not be completed.');
    this.name = 'PasskeyReauthenticationFailedError';
    this.failureCategory = failureCategory;
  }
}

export class LastActivePasskeyRequiredError extends Error {
  readonly code = 'LAST_ACTIVE_PASSKEY_REQUIRED';
  constructor() {
    super('At least one active passkey is required.');
    this.name = 'LastActivePasskeyRequiredError';
  }
}

export class RateLimitedError extends Error {
  readonly code = 'RATE_LIMITED';
  constructor() {
    super('Rate limit exceeded.');
    this.name = 'RateLimitedError';
  }
}

export class InvalidPasskeyLabelRequestError extends Error {
  readonly code = 'INVALID_PASSKEY_LABEL';
  constructor() {
    super('Passkey label is invalid.');
    this.name = 'InvalidPasskeyLabelRequestError';
  }
}

export type ManagedPasskeyView = {
  id: string;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  deviceType: 'multiDevice' | 'singleDevice' | null;
  backupEligible: boolean | null;
  backedUp: boolean | null;
  currentSessionCredential: boolean;
};

export type SessionRotationResult = {
  session: AccountSessionRow;
  rawToken: string;
  clientType: AccountSessionClientType;
};

function toBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  throw new Error('invalid_buffer');
}

function evaluateCounterPolicy(storedCounter: number, newCounter: number): 'accept' | 'anomaly' {
  if (storedCounter === 0 && newCounter === 0) {
    return 'accept';
  }
  if (newCounter > storedCounter) {
    return 'accept';
  }
  if (storedCounter > 0 && newCounter <= storedCounter) {
    return 'anomaly';
  }
  return 'anomaly';
}

function resolveBackupState(input: {
  storedBackedUp: boolean | null;
  storedBackupEligible: boolean | null;
  credentialDeviceType: 'singleDevice' | 'multiDevice';
  credentialBackedUp: boolean;
}): { backedUp: boolean; backupEligible: boolean; transition: string } {
  const backupEligible = input.storedBackupEligible ?? input.credentialDeviceType === 'multiDevice';
  const backedUp = input.storedBackedUp === true ? true : input.credentialBackedUp;
  let transition = 'unchanged';
  if (input.storedBackedUp !== true && backedUp) {
    transition = 'false_to_true';
  } else if (input.storedBackedUp === true && !input.credentialBackedUp) {
    transition = 'kept_backed_up';
  }
  return { backedUp, backupEligible, transition };
}

export function isSessionFreshForManagement(session: AccountSessionRow, now: string): boolean {
  if (session.freshAuthenticatedAt == null) {
    return false;
  }
  const freshUntil = addMinutes(session.freshAuthenticatedAt, PASSKEY_FRESHNESS_MINUTES);
  return new Date(now).getTime() <= new Date(freshUntil).getTime();
}

export function computeFreshUntil(freshAuthenticatedAt: string): string {
  return addMinutes(freshAuthenticatedAt, PASSKEY_FRESHNESS_MINUTES);
}

function mapDeviceType(backupEligible: boolean | null): 'multiDevice' | 'singleDevice' | null {
  if (backupEligible === true) {
    return 'multiDevice';
  }
  if (backupEligible === false) {
    return 'singleDevice';
  }
  return null;
}

function toManagedPasskeyView(
  row: PasskeyCredentialRow,
  currentAuthenticatedPasskeyId: string | null,
): ManagedPasskeyView {
  return {
    id: row.publicId,
    label: row.label,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    deviceType: mapDeviceType(row.backupEligible),
    backupEligible: row.backupEligible,
    backedUp: row.backedUp,
    currentSessionCredential: currentAuthenticatedPasskeyId === row.id,
  };
}

function accountAlias(accountId: string): string {
  return `town-member-${accountId.replace(/-/g, '').slice(0, 12)}`;
}

function assertActiveAccount(account: { status: string } | null | undefined): void {
  if (account?.status !== 'active') {
    throw new SessionNotAuthorizedError();
  }
}

async function rotateSessionPreservingFreshness(
  db: Db,
  deps: PasskeyManagementDeps,
  input: {
    session: AccountSessionRow;
    now: string;
    requestId?: string | null;
    freshAuthenticatedAt?: string | null;
    authenticatedPasskeyId?: string | null;
  },
): Promise<SessionRotationResult> {
  const config = requirePasskeyManagementConfig(deps.env);
  const generateId = deps.generateId ?? (() => randomUUID());
  const generateToken = deps.generateToken ?? generateSessionToken;
  const rawToken = generateToken();
  const newTokenHash = hashSessionToken({
    hashKey: config.sessionTokenHashKey,
    clientType: input.session.clientType as AccountSessionClientType,
    token: rawToken,
  });
  const { replacement } = await rotateAccountSessionTx(db, {
    oldSessionId: input.session.id,
    newSessionId: generateId(),
    newTokenHash,
    now: input.now,
    ...(input.freshAuthenticatedAt !== undefined
      ? { freshAuthenticatedAt: input.freshAuthenticatedAt }
      : {}),
    ...(input.authenticatedPasskeyId !== undefined
      ? { authenticatedPasskeyId: input.authenticatedPasskeyId }
      : {}),
    eventId: generateId(),
    requestId: input.requestId ?? null,
  });
  return {
    session: replacement,
    rawToken,
    clientType: replacement.clientType as AccountSessionClientType,
  };
}

export async function listPasskeyInventory(
  db: Db,
  deps: PasskeyManagementDeps,
  input: {
    session: AccountSessionRow;
    requestId?: string | null;
  },
): Promise<{ passkeys: ManagedPasskeyView[] }> {
  const config = requirePasskeyManagementConfig(deps.env);
  const now = deps.now();
  const generateId = deps.generateId ?? (() => randomUUID());
  const account = await findAccountById(db, input.session.accountId);
  assertActiveAccount(account);

  if (
    await isPasskeyInventoryThrottled(db, {
      rateLimitHashKey: config.rateLimitHashKey,
      accountId: input.session.accountId,
      now,
    })
  ) {
    await recordPasskeyInventoryAttempt(db, {
      rateLimitHashKey: config.rateLimitHashKey,
      accountId: input.session.accountId,
      now,
      throttled: true,
      requestId: input.requestId ?? null,
    });
    throw new RateLimitedError();
  }

  const currentId = input.session.authenticatedPasskeyId;
  const rows = await db
    .select()
    .from(passkeyCredentials)
    .where(
      and(
        eq(passkeyCredentials.accountId, input.session.accountId),
        isNull(passkeyCredentials.revokedAt),
      ),
    );

  rows.sort((a, b) => {
    const aCurrent = currentId !== null && a.id === currentId ? 0 : 1;
    const bCurrent = currentId !== null && b.id === currentId ? 0 : 1;
    if (aCurrent !== bCurrent) {
      return aCurrent - bCurrent;
    }
    const aUsed = a.lastUsedAt ? new Date(a.lastUsedAt).getTime() : Number.NEGATIVE_INFINITY;
    const bUsed = b.lastUsedAt ? new Date(b.lastUsedAt).getTime() : Number.NEGATIVE_INFINITY;
    if (aUsed !== bUsed) {
      return bUsed - aUsed;
    }
    const created = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    if (created !== 0) {
      return created;
    }
    return a.publicId.localeCompare(b.publicId);
  });

  await recordPasskeyInventoryAttempt(db, {
    rateLimitHashKey: config.rateLimitHashKey,
    accountId: input.session.accountId,
    now,
    throttled: false,
    requestId: input.requestId ?? null,
  });

  await appendIdentitySecurityEvent(db, {
    id: generateId(),
    accountId: input.session.accountId,
    eventType: 'passkey_inventory_viewed',
    occurredAt: now,
    requestId: input.requestId ?? null,
    metadata: {
      passkeyCount: rows.length,
    },
  });

  return {
    passkeys: rows.map((row) => toManagedPasskeyView(row, currentId)),
  };
}

export async function createPasskeyReauthenticationOptions(
  db: Db,
  deps: PasskeyManagementDeps,
  input: {
    session: AccountSessionRow;
    requestId?: string | null;
  },
): Promise<{
  reauthenticationCeremonyId: string;
  options: Awaited<ReturnType<typeof generateAuthenticationOptions>>;
}> {
  const config = requirePasskeyManagementConfig(deps.env);
  const now = deps.now();
  const generateId = deps.generateId ?? (() => randomUUID());
  const account = await findAccountById(db, input.session.accountId);
  assertActiveAccount(account);

  if (
    await isManageReauthOptionsThrottled(db, {
      rateLimitHashKey: config.rateLimitHashKey,
      sessionId: input.session.id,
      now,
    })
  ) {
    await recordManageReauthOptionsAttempt(db, {
      rateLimitHashKey: config.rateLimitHashKey,
      accountId: input.session.accountId,
      sessionId: input.session.id,
      now,
      throttled: true,
      requestId: input.requestId ?? null,
    });
    throw new RateLimitedError();
  }

  const activePasskeys = await listActivePasskeys(db, input.session.accountId);
  if (activePasskeys.length === 0) {
    throw new PasskeyReauthenticationFailedError('no_active_passkeys');
  }

  const allowCredentials = activePasskeys.map((credential) => {
    const descriptor: {
      id: string;
      transports?: AuthenticatorTransportFuture[];
    } = {
      id: isoBase64URL.fromBuffer(new Uint8Array(toBuffer(credential.credentialId))),
    };
    if (credential.transports && credential.transports.length > 0) {
      descriptor.transports = credential.transports as AuthenticatorTransportFuture[];
    }
    return descriptor;
  });

  const ceremonyId = generateId();
  const options = await generateAuthenticationOptions({
    rpID: config.rpId,
    timeout: MANAGE_PASSKEYS_TIMEOUT_MS,
    allowCredentials,
    userVerification: 'required',
  });

  const challengeHash = hashManageWebAuthnChallenge({
    hashKey: config.challengeHashKey,
    challengeId: ceremonyId,
    purpose: 'manage_passkeys_authenticate',
    accountId: input.session.accountId,
    sessionId: input.session.id,
    rpId: config.rpId,
    rawChallenge: options.challenge,
  });

  await db.transaction(async (tx) => {
    const dbTx = tx as unknown as Db;
    await revokeActiveWebAuthnChallengesForSession(dbTx, {
      sessionId: input.session.id,
      purpose: 'manage_passkeys_authenticate',
      now,
    });
    await createWebAuthnChallenge(dbTx, {
      id: ceremonyId,
      accountId: input.session.accountId,
      sessionId: input.session.id,
      purpose: 'manage_passkeys_authenticate',
      challengeHash,
      createdAt: now,
      expiresAt: addMinutes(now, MANAGE_PASSKEYS_CHALLENGE_TTL_MINUTES),
    });
  });

  await recordManageReauthOptionsAttempt(db, {
    rateLimitHashKey: config.rateLimitHashKey,
    accountId: input.session.accountId,
    sessionId: input.session.id,
    now,
    throttled: false,
    requestId: input.requestId ?? null,
  });

  await appendIdentitySecurityEvent(db, {
    id: generateId(),
    accountId: input.session.accountId,
    eventType: 'passkey_reauthentication_started',
    occurredAt: now,
    requestId: input.requestId ?? null,
    metadata: { purpose: 'manage_passkeys_authenticate' },
  });

  return { reauthenticationCeremonyId: ceremonyId, options };
}

export async function verifyPasskeyReauthentication(
  db: Db,
  deps: PasskeyManagementDeps,
  input: {
    session: AccountSessionRow;
    reauthenticationCeremonyId: string;
    response: AuthenticationResponseJSON;
    requestId?: string | null;
  },
): Promise<{
  status: 'FRESH_AUTHENTICATION_CONFIRMED';
  freshUntil: string;
  rotation: SessionRotationResult;
}> {
  const config = requirePasskeyManagementConfig(deps.env);
  const now = deps.now();
  const generateId = deps.generateId ?? (() => randomUUID());
  const accountId = input.session.accountId;

  if (
    await isManageReauthVerifyThrottled(db, {
      rateLimitHashKey: config.rateLimitHashKey,
      sessionId: input.session.id,
      now,
    })
  ) {
    await recordManageReauthVerifyFailedAttempt(db, {
      rateLimitHashKey: config.rateLimitHashKey,
      accountId,
      sessionId: input.session.id,
      now,
      failureCategory: 'rate_limited_verify',
      requestId: input.requestId ?? null,
    });
    throw new RateLimitedError();
  }

  const fail = async (category: string): Promise<never> => {
    await recordManageReauthVerifyFailedAttempt(db, {
      rateLimitHashKey: config.rateLimitHashKey,
      accountId,
      sessionId: input.session.id,
      now,
      failureCategory: category,
      requestId: input.requestId ?? null,
    }).catch(() => undefined);
    await appendIdentitySecurityEvent(db, {
      id: generateId(),
      accountId,
      eventType: 'passkey_reauthentication_failed',
      occurredAt: now,
      requestId: input.requestId ?? null,
      metadata: {
        purpose: 'manage_passkeys_authenticate',
        failureCategory: category,
      },
    }).catch(() => undefined);
    throw new PasskeyReauthenticationFailedError(category);
  };

  const challengeRow = await findWebAuthnChallengeById(db, input.reauthenticationCeremonyId);
  if (!challengeRow) {
    return await fail('challenge_unknown');
  }
  if (challengeRow.accountId !== accountId || challengeRow.sessionId !== input.session.id) {
    return await fail('challenge_binding_mismatch');
  }
  if (challengeRow.purpose !== 'manage_passkeys_authenticate') {
    return await fail('challenge_wrong_purpose');
  }
  if (challengeRow.consumedAt !== null || challengeRow.revokedAt !== null) {
    return await fail('challenge_inactive');
  }
  if (new Date(now).getTime() >= new Date(challengeRow.expiresAt).getTime()) {
    return await fail('challenge_expired');
  }

  const credentialId = Buffer.from(isoBase64URL.toBuffer(input.response.id));
  const credential = await findActivePasskeyByCredentialId(db, credentialId);
  if (credential?.accountId !== accountId) {
    return await fail('credential_unknown');
  }

  let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verification = await verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge: (clientChallenge) =>
        verifyManageWebAuthnChallengeHash({
          hashKey: config.challengeHashKey,
          challengeId: challengeRow.id,
          purpose: 'manage_passkeys_authenticate',
          accountId,
          sessionId: input.session.id,
          rpId: config.rpId,
          rawChallenge: clientChallenge,
          expectedHash: toBuffer(challengeRow.challengeHash),
        }),
      expectedOrigin: [...config.allowedOrigins],
      expectedRPID: config.rpId,
      requireUserVerification: true,
      credential: {
        id: isoBase64URL.fromBuffer(new Uint8Array(toBuffer(credential.credentialId))),
        publicKey: new Uint8Array(toBuffer(credential.publicKey)),
        counter: credential.signCount,
        ...(credential.transports && credential.transports.length > 0
          ? { transports: credential.transports as AuthenticatorTransportFuture[] }
          : {}),
      },
    });
  } catch {
    return await fail('webauthn_verify_failed');
  }

  if (!verification.verified || !verification.authenticationInfo.userVerified) {
    return await fail('webauthn_not_verified');
  }

  const newCounter = verification.authenticationInfo.newCounter;
  if (evaluateCounterPolicy(credential.signCount, newCounter) === 'anomaly') {
    await appendIdentitySecurityEvent(db, {
      id: generateId(),
      accountId,
      eventType: 'counter_anomaly_detected',
      occurredAt: now,
      requestId: input.requestId ?? null,
      metadata: { purpose: 'manage_passkeys_authenticate', failureCategory: 'counter_anomaly' },
    }).catch(() => undefined);
    return await fail('counter_anomaly');
  }

  const backup = resolveBackupState({
    storedBackedUp: credential.backedUp,
    storedBackupEligible: credential.backupEligible,
    credentialDeviceType: verification.authenticationInfo.credentialDeviceType,
    credentialBackedUp: verification.authenticationInfo.credentialBackedUp,
  });

  let rotation: SessionRotationResult;
  try {
    await db.transaction(async (tx) => {
      const dbTx = tx as unknown as Db;
      const lockedAccount = await lockAccountById(dbTx, accountId);
      assertActiveAccount(lockedAccount);

      const lockedCred = await dbTx
        .select()
        .from(passkeyCredentials)
        .where(eq(passkeyCredentials.id, credential.id))
        .limit(1)
        .for('update');
      if (!lockedCred[0] || lockedCred[0].revokedAt != null) {
        throw new PasskeyReauthenticationFailedError('credential_inactive');
      }

      await updatePasskeyAuthenticationState(dbTx, {
        credentialRowId: credential.id,
        signCount: newCounter,
        backedUp: backup.backedUp,
        backupEligible: backup.backupEligible,
        lastUsedAt: now,
      });

      const consumed = await dbTx
        .update(webauthnChallenges)
        .set({ consumedAt: now })
        .where(
          and(
            eq(webauthnChallenges.id, challengeRow.id),
            isNull(webauthnChallenges.consumedAt),
            isNull(webauthnChallenges.revokedAt),
            gt(webauthnChallenges.expiresAt, now),
          ),
        )
        .returning();
      if (!consumed[0]) {
        throw new PasskeyReauthenticationFailedError('challenge_consume_failed');
      }

      rotation = await rotateSessionPreservingFreshness(dbTx, deps, {
        session: input.session,
        now,
        requestId: input.requestId ?? null,
        freshAuthenticatedAt: now,
        authenticatedPasskeyId: credential.id,
      });

      await appendIdentitySecurityEvent(dbTx, {
        id: generateId(),
        accountId,
        eventType: 'passkey_reauthentication_succeeded',
        occurredAt: now,
        requestId: input.requestId ?? null,
        metadata: {
          purpose: 'manage_passkeys_authenticate',
          backupState: backup.transition,
        },
      });
      await appendIdentitySecurityEvent(dbTx, {
        id: generateId(),
        accountId,
        eventType: 'passkey_used',
        occurredAt: now,
        requestId: input.requestId ?? null,
        metadata: {
          purpose: 'manage_passkeys_authenticate',
        },
      });
    });
  } catch (error) {
    if (error instanceof PasskeyReauthenticationFailedError) {
      return await fail(error.failureCategory);
    }
    if (error instanceof SessionNotAuthorizedError) {
      throw error;
    }
    return await fail('activation_failed');
  }

  return {
    status: 'FRESH_AUTHENTICATION_CONFIRMED',
    freshUntil: computeFreshUntil(now),
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    rotation: rotation!,
  };
}

export async function createManagedPasskeyRegistrationOptions(
  db: Db,
  deps: PasskeyManagementDeps,
  input: {
    session: AccountSessionRow;
    requestId?: string | null;
  },
): Promise<{
  registrationCeremonyId: string;
  options: Awaited<ReturnType<typeof generateRegistrationOptions>>;
}> {
  const config = requirePasskeyManagementConfig(deps.env);
  const now = deps.now();
  const generateId = deps.generateId ?? (() => randomUUID());
  const account = await findAccountById(db, input.session.accountId);
  assertActiveAccount(account);

  if (!isSessionFreshForManagement(input.session, now)) {
    throw new FreshAuthenticationRequiredError();
  }

  if (
    await isManageRegisterOptionsThrottled(db, {
      rateLimitHashKey: config.rateLimitHashKey,
      sessionId: input.session.id,
      now,
    })
  ) {
    await recordManageRegisterOptionsAttempt(db, {
      rateLimitHashKey: config.rateLimitHashKey,
      accountId: input.session.accountId,
      sessionId: input.session.id,
      now,
      throttled: true,
      requestId: input.requestId ?? null,
    });
    throw new RateLimitedError();
  }

  if (!account?.webauthnUserHandle) {
    throw new PasskeyRegistrationFailedError('user_handle_missing');
  }

  const activePasskeys = await listActivePasskeys(db, input.session.accountId);
  const excludeCredentials = activePasskeys.map((credential) => {
    const descriptor: {
      id: string;
      transports?: AuthenticatorTransportFuture[];
    } = {
      id: isoBase64URL.fromBuffer(new Uint8Array(toBuffer(credential.credentialId))),
    };
    if (credential.transports && credential.transports.length > 0) {
      descriptor.transports = credential.transports as AuthenticatorTransportFuture[];
    }
    return descriptor;
  });

  const ceremonyId = generateId();
  const options = await generateRegistrationOptions({
    rpName: config.rpName,
    rpID: config.rpId,
    userName: accountAlias(input.session.accountId),
    userDisplayName: CIVIC_ACTOR_DISPLAY_LABEL,
    userID: new Uint8Array(toBuffer(account.webauthnUserHandle)),
    timeout: MANAGE_PASSKEYS_TIMEOUT_MS,
    attestationType: 'none',
    excludeCredentials,
    authenticatorSelection: {
      residentKey: 'required',
      requireResidentKey: true,
      userVerification: 'required',
    },
    supportedAlgorithmIDs: [...WEBAUTHN_SUPPORTED_ALGORITHM_IDS],
  });

  const challengeHash = hashManageWebAuthnChallenge({
    hashKey: config.challengeHashKey,
    challengeId: ceremonyId,
    purpose: 'manage_passkeys_register',
    accountId: input.session.accountId,
    sessionId: input.session.id,
    rpId: config.rpId,
    rawChallenge: options.challenge,
  });

  await db.transaction(async (tx) => {
    const dbTx = tx as unknown as Db;
    await revokeActiveWebAuthnChallengesForSession(dbTx, {
      sessionId: input.session.id,
      purpose: 'manage_passkeys_register',
      now,
    });
    await createWebAuthnChallenge(dbTx, {
      id: ceremonyId,
      accountId: input.session.accountId,
      sessionId: input.session.id,
      purpose: 'manage_passkeys_register',
      challengeHash,
      createdAt: now,
      expiresAt: addMinutes(now, MANAGE_PASSKEYS_CHALLENGE_TTL_MINUTES),
    });
  });

  await recordManageRegisterOptionsAttempt(db, {
    rateLimitHashKey: config.rateLimitHashKey,
    accountId: input.session.accountId,
    sessionId: input.session.id,
    now,
    throttled: false,
    requestId: input.requestId ?? null,
  });

  return { registrationCeremonyId: ceremonyId, options };
}

export async function verifyManagedPasskeyRegistration(
  db: Db,
  deps: PasskeyManagementDeps,
  input: {
    session: AccountSessionRow;
    registrationCeremonyId: string;
    response: RegistrationResponseJSON;
    label?: string | null;
    requestId?: string | null;
  },
): Promise<{
  status: 'PASSKEY_ADDED';
  passkey: { id: string; label: string | null; createdAt: string };
  rotation: SessionRotationResult;
}> {
  const config = requirePasskeyManagementConfig(deps.env);
  const now = deps.now();
  const generateId = deps.generateId ?? (() => randomUUID());
  const accountId = input.session.accountId;
  let normalizedLabel: string | null = null;
  try {
    normalizedLabel = normalizeLabel(input.label);
  } catch {
    throw new InvalidPasskeyLabelRequestError();
  }

  if (!isSessionFreshForManagement(input.session, now)) {
    throw new FreshAuthenticationRequiredError();
  }

  if (
    await isManageRegisterVerifyThrottled(db, {
      rateLimitHashKey: config.rateLimitHashKey,
      sessionId: input.session.id,
      now,
    })
  ) {
    await recordManageRegisterVerifyFailedAttempt(db, {
      rateLimitHashKey: config.rateLimitHashKey,
      accountId,
      sessionId: input.session.id,
      now,
      failureCategory: 'rate_limited_verify',
      requestId: input.requestId ?? null,
    });
    throw new RateLimitedError();
  }

  const fail = async (category: string): Promise<never> => {
    await recordManageRegisterVerifyFailedAttempt(db, {
      rateLimitHashKey: config.rateLimitHashKey,
      accountId,
      sessionId: input.session.id,
      now,
      failureCategory: category,
      requestId: input.requestId ?? null,
    }).catch(() => undefined);
    await appendIdentitySecurityEvent(db, {
      id: generateId(),
      accountId,
      eventType: 'passkey_registration_failed',
      occurredAt: now,
      requestId: input.requestId ?? null,
      metadata: {
        purpose: 'manage_passkeys_register',
        failureCategory: category,
      },
    }).catch(() => undefined);
    throw new PasskeyRegistrationFailedError(category);
  };

  const challengeRow = await findWebAuthnChallengeById(db, input.registrationCeremonyId);
  if (!challengeRow) {
    return await fail('challenge_unknown');
  }
  if (challengeRow.accountId !== accountId || challengeRow.sessionId !== input.session.id) {
    return await fail('challenge_binding_mismatch');
  }
  if (challengeRow.purpose !== 'manage_passkeys_register') {
    return await fail('challenge_wrong_purpose');
  }
  if (challengeRow.consumedAt !== null || challengeRow.revokedAt !== null) {
    return await fail('challenge_inactive');
  }
  if (new Date(now).getTime() >= new Date(challengeRow.expiresAt).getTime()) {
    return await fail('challenge_expired');
  }

  const account = await findAccountById(db, accountId);
  if (!account?.webauthnUserHandle) {
    return await fail('user_handle_missing');
  }

  let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verification = await verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: (clientChallenge) =>
        verifyManageWebAuthnChallengeHash({
          hashKey: config.challengeHashKey,
          challengeId: challengeRow.id,
          purpose: 'manage_passkeys_register',
          accountId,
          sessionId: input.session.id,
          rpId: config.rpId,
          rawChallenge: clientChallenge,
          expectedHash: toBuffer(challengeRow.challengeHash),
        }),
      expectedOrigin: [...config.allowedOrigins],
      expectedRPID: config.rpId,
      requireUserVerification: true,
      supportedAlgorithmIDs: [...WEBAUTHN_SUPPORTED_ALGORITHM_IDS],
    });
  } catch {
    return await fail('webauthn_verify_failed');
  }

  if (!verification.verified || !verification.registrationInfo.userVerified) {
    return await fail('webauthn_not_verified');
  }

  const { credential, credentialDeviceType, credentialBackedUp, aaguid } =
    verification.registrationInfo;
  if (!credential.id || credential.publicKey.byteLength === 0) {
    return await fail('credential_incomplete');
  }

  const credentialId = Buffer.from(isoBase64URL.toBuffer(credential.id));
  const publicKey = Buffer.from(credential.publicKey);
  const signCount = credential.counter;
  if (signCount < 0) {
    return await fail('invalid_sign_count');
  }

  const publicId = generateId();
  let rotation: SessionRotationResult;
  try {
    await db.transaction(async (tx) => {
      const dbTx = tx as unknown as Db;
      const lockedAccount = await lockAccountById(dbTx, accountId);
      assertActiveAccount(lockedAccount);

      const consumed = await dbTx
        .update(webauthnChallenges)
        .set({ consumedAt: now })
        .where(
          and(
            eq(webauthnChallenges.id, challengeRow.id),
            isNull(webauthnChallenges.consumedAt),
            isNull(webauthnChallenges.revokedAt),
            gt(webauthnChallenges.expiresAt, now),
          ),
        )
        .returning();
      if (!consumed[0]) {
        throw new PasskeyRegistrationFailedError('challenge_consume_failed');
      }

      await addPasskeyCredential(dbTx, {
        id: generateId(),
        publicId,
        accountId,
        credentialId,
        publicKey,
        signCount,
        transports: credential.transports ?? null,
        deviceType: null,
        backedUp: credentialBackedUp,
        backupEligible: credentialDeviceType === 'multiDevice',
        aaguid: aaguid && aaguid !== '00000000-0000-0000-0000-000000000000' ? aaguid : null,
        label: normalizedLabel,
        createdAt: now,
      });

      rotation = await rotateSessionPreservingFreshness(dbTx, deps, {
        session: input.session,
        now,
        requestId: input.requestId ?? null,
        // Preserve freshness from the prior session (reauth window).
        freshAuthenticatedAt: input.session.freshAuthenticatedAt,
        authenticatedPasskeyId: input.session.authenticatedPasskeyId,
      });

      await revokeAllOtherAccountSessions(dbTx, {
        accountId,
        keepSessionId: rotation.session.id,
        reason: 'passkey_added',
        now,
        eventId: generateId(),
        requestId: input.requestId ?? null,
      });

      await appendIdentitySecurityEvent(dbTx, {
        id: generateId(),
        accountId,
        eventType: 'passkey_registered',
        occurredAt: now,
        requestId: input.requestId ?? null,
        metadata: {
          purpose: 'manage_passkeys_register',
          backupState: credentialBackedUp ? 'backed_up' : 'not_backed_up',
        },
      });
      await appendIdentitySecurityEvent(dbTx, {
        id: generateId(),
        accountId,
        eventType: 'passkey_management_changed',
        occurredAt: now,
        requestId: input.requestId ?? null,
        metadata: {
          change: 'passkey_added',
        },
      });
    });
  } catch (error) {
    if (error instanceof PasskeyRegistrationFailedError) {
      return await fail(error.failureCategory);
    }
    if (
      error instanceof SessionNotAuthorizedError ||
      error instanceof FreshAuthenticationRequiredError
    ) {
      throw error;
    }
    const message = error instanceof Error ? error.message : '';
    if (/DUPLICATE_CREDENTIAL_ID|passkey_credentials_credential_id_unique/i.test(message)) {
      return await fail('duplicate_credential');
    }
    return await fail('activation_failed');
  }

  return {
    status: 'PASSKEY_ADDED',
    passkey: {
      id: publicId,
      label: normalizedLabel,
      createdAt: now,
    },
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    rotation: rotation!,
  };
}

export async function renamePasskey(
  db: Db,
  deps: PasskeyManagementDeps,
  input: {
    session: AccountSessionRow;
    passkeyId: string;
    label: string | null;
    requestId?: string | null;
  },
): Promise<{ status: 'PASSKEY_UPDATED'; passkey: ManagedPasskeyView }> {
  const config = requirePasskeyManagementConfig(deps.env);
  const now = deps.now();
  const generateId = deps.generateId ?? (() => randomUUID());
  const account = await findAccountById(db, input.session.accountId);
  assertActiveAccount(account);

  if (
    await isPasskeyRenameThrottled(db, {
      rateLimitHashKey: config.rateLimitHashKey,
      accountId: input.session.accountId,
      now,
    })
  ) {
    await recordPasskeyRenameAttempt(db, {
      rateLimitHashKey: config.rateLimitHashKey,
      accountId: input.session.accountId,
      now,
      throttled: true,
      requestId: input.requestId ?? null,
    });
    throw new RateLimitedError();
  }

  let normalized: string | null;
  try {
    normalized = normalizeLabel(input.label);
  } catch (error) {
    if (error instanceof InvalidPasskeyLabelError) {
      throw new InvalidPasskeyLabelRequestError();
    }
    throw error;
  }

  const credential = await findActivePasskeyByPublicId(db, {
    publicId: input.passkeyId,
    accountId: input.session.accountId,
  });
  if (!credential) {
    throw new PasskeyNotFoundError();
  }

  await recordPasskeyRenameAttempt(db, {
    rateLimitHashKey: config.rateLimitHashKey,
    accountId: input.session.accountId,
    now,
    throttled: false,
    requestId: input.requestId ?? null,
  });

  if (credential.label === normalized) {
    return {
      status: 'PASSKEY_UPDATED',
      passkey: toManagedPasskeyView(credential, input.session.authenticatedPasskeyId),
    };
  }

  const updated = await updatePasskeyLabel(db, {
    credentialRowId: credential.id,
    label: normalized,
  });

  await appendIdentitySecurityEvent(db, {
    id: generateId(),
    accountId: input.session.accountId,
    eventType: 'passkey_renamed',
    occurredAt: now,
    requestId: input.requestId ?? null,
    metadata: {
      passkeyPublicId: updated.publicId,
    },
  });
  await appendIdentitySecurityEvent(db, {
    id: generateId(),
    accountId: input.session.accountId,
    eventType: 'passkey_management_changed',
    occurredAt: now,
    requestId: input.requestId ?? null,
    metadata: {
      change: 'passkey_renamed',
      passkeyPublicId: updated.publicId,
    },
  });

  return {
    status: 'PASSKEY_UPDATED',
    passkey: toManagedPasskeyView(updated, input.session.authenticatedPasskeyId),
  };
}

export async function revokeManagedPasskey(
  db: Db,
  deps: PasskeyManagementDeps,
  input: {
    session: AccountSessionRow;
    passkeyId: string;
    requestId?: string | null;
  },
): Promise<{ status: 'PASSKEY_REVOKED'; rotation: SessionRotationResult }> {
  const config = requirePasskeyManagementConfig(deps.env);
  const now = deps.now();
  const generateId = deps.generateId ?? (() => randomUUID());
  const account = await findAccountById(db, input.session.accountId);
  assertActiveAccount(account);

  if (!isSessionFreshForManagement(input.session, now)) {
    throw new FreshAuthenticationRequiredError();
  }

  if (
    await isPasskeyRevokeThrottled(db, {
      rateLimitHashKey: config.rateLimitHashKey,
      accountId: input.session.accountId,
      now,
    })
  ) {
    await recordPasskeyRevokeAttempt(db, {
      rateLimitHashKey: config.rateLimitHashKey,
      accountId: input.session.accountId,
      now,
      throttled: true,
      requestId: input.requestId ?? null,
    });
    throw new RateLimitedError();
  }

  const credential = await findActivePasskeyByPublicId(db, {
    publicId: input.passkeyId,
    accountId: input.session.accountId,
  });
  if (!credential) {
    throw new PasskeyNotFoundError();
  }

  if (input.session.authenticatedPasskeyId === credential.id) {
    throw new FreshAuthenticationRequiredError();
  }

  await recordPasskeyRevokeAttempt(db, {
    rateLimitHashKey: config.rateLimitHashKey,
    accountId: input.session.accountId,
    now,
    throttled: false,
    requestId: input.requestId ?? null,
  });

  let rotation: SessionRotationResult;
  try {
    await db.transaction(async (tx) => {
      const dbTx = tx as unknown as Db;
      const lockedAccount = await lockAccountById(dbTx, input.session.accountId);
      assertActiveAccount(lockedAccount);

      try {
        await revokePasskey(dbTx, {
          credentialRowId: credential.id,
          revokedAt: now,
          revocationReason: 'user_requested',
        });
      } catch (error) {
        if (error instanceof IdentityInvariantError && error.code === 'FINAL_PASSKEY_PROTECTED') {
          throw new LastActivePasskeyRequiredError();
        }
        if (error instanceof IdentityInvariantError && error.code === 'PASSKEY_NOT_ACTIVE') {
          throw new PasskeyNotFoundError();
        }
        throw error;
      }

      const remainingAuthCredential =
        input.session.authenticatedPasskeyId != null &&
        input.session.authenticatedPasskeyId !== credential.id
          ? input.session.authenticatedPasskeyId
          : null;

      rotation = await rotateSessionPreservingFreshness(dbTx, deps, {
        session: input.session,
        now,
        requestId: input.requestId ?? null,
        freshAuthenticatedAt: remainingAuthCredential ? input.session.freshAuthenticatedAt : null,
        authenticatedPasskeyId: remainingAuthCredential,
      });

      await revokeAllOtherAccountSessions(dbTx, {
        accountId: input.session.accountId,
        keepSessionId: rotation.session.id,
        reason: 'passkey_revoked',
        now,
        eventId: generateId(),
        requestId: input.requestId ?? null,
      });

      await appendIdentitySecurityEvent(dbTx, {
        id: generateId(),
        accountId: input.session.accountId,
        eventType: 'passkey_revoked',
        occurredAt: now,
        requestId: input.requestId ?? null,
        metadata: {
          reason: 'user_requested',
        },
      });
      await appendIdentitySecurityEvent(dbTx, {
        id: generateId(),
        accountId: input.session.accountId,
        eventType: 'passkey_management_changed',
        occurredAt: now,
        requestId: input.requestId ?? null,
        metadata: {
          change: 'passkey_revoked',
        },
      });
    });
  } catch (error) {
    if (
      error instanceof LastActivePasskeyRequiredError ||
      error instanceof PasskeyNotFoundError ||
      error instanceof FreshAuthenticationRequiredError ||
      error instanceof SessionNotAuthorizedError
    ) {
      throw error;
    }
    throw error;
  }

  return {
    status: 'PASSKEY_REVOKED',
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    rotation: rotation!,
  };
}

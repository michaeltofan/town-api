import { createHash, randomUUID } from 'node:crypto';
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
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
} from '../../db/schema.js';
import { findAccountById, lockAccountById } from '../../identity/repositories/accounts.js';
import {
  createWebAuthnChallenge,
  findWebAuthnChallengeById,
} from '../../identity/repositories/challenges.js';
import {
  findActivePasskeyByCredentialId,
  updatePasskeyAuthenticationState,
} from '../../identity/repositories/passkeys.js';
import { appendIdentitySecurityEvent } from '../../identity/repositories/security-events.js';
import { addMinutes, isSensitiveOperationFresh } from '../policy.js';
import {
  createAccountSession,
  findActiveAccountSessionByTokenHash,
  rotateAccountSession,
  revokeAccountSession,
  revokeAllAccountSessions,
  touchAccountSession,
} from '../repositories/account-sessions.js';
import { requirePasskeyAuthenticationConfig, requireSessionRuntimeConfig } from './config.js';
import {
  generateSessionToken,
  hashAuthenticationChallenge,
  hashSessionToken,
  verifyAuthenticationChallengeHash,
} from './crypto.js';
import {
  PASSKEY_AUTHENTICATION_CHALLENGE_TTL_MINUTES,
  PASSKEY_AUTHENTICATION_TIMEOUT_MS,
  SESSION_TOUCH_MIN_INTERVAL_MS,
} from './policy.js';
import {
  isPasskeyAssertionThrottled,
  isPasskeyOptionsThrottled,
  recordPasskeyAssertionFailedAttempt,
  recordPasskeyOptionsAttempt,
} from './rate-limits.js';

type Db = Database['db'];

export type PasskeyAuthenticationDeps = {
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

export class RecentAuthenticationRequiredError extends Error {
  readonly code = 'RECENT_AUTHENTICATION_REQUIRED';

  constructor() {
    super('Recent authentication is required.');
    this.name = 'RecentAuthenticationRequiredError';
  }
}

function toBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  throw new AuthenticationFailedError('invalid_buffer');
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
  // Synced/backed-up passkeys are never downgraded.
  const backedUp = input.storedBackedUp === true ? true : input.credentialBackedUp;
  let transition = 'unchanged';
  if (input.storedBackedUp !== true && backedUp) {
    transition = 'false_to_true';
  } else if (input.storedBackedUp === true && !input.credentialBackedUp) {
    transition = 'kept_backed_up';
  }
  return { backedUp, backupEligible, transition };
}

function credentialRateSubject(credentialId: Buffer): string {
  return createHash('sha256').update(credentialId).digest('base64url');
}

export async function createPasskeyAuthenticationOptions(
  db: Db,
  deps: PasskeyAuthenticationDeps,
  input: {
    clientType: AccountSessionClientType;
    anonymousClientKey: string;
    ip: string;
    requestId?: string | null;
  },
): Promise<{
  authenticationCeremonyId: string;
  options: Awaited<ReturnType<typeof generateAuthenticationOptions>>;
}> {
  const config = requirePasskeyAuthenticationConfig(deps.env);
  const now = deps.now();
  const generateId = deps.generateId ?? (() => randomUUID());

  if (
    await isPasskeyOptionsThrottled(db, {
      rateLimitHashKey: config.rateLimitHashKey,
      ip: input.ip,
      anonymousClientKey: input.anonymousClientKey,
      now,
    })
  ) {
    await recordPasskeyOptionsAttempt(db, {
      rateLimitHashKey: config.rateLimitHashKey,
      ip: input.ip,
      anonymousClientKey: input.anonymousClientKey,
      now,
      throttled: true,
      requestId: input.requestId ?? null,
    });
    throw new AuthenticationFailedError('rate_limited_options');
  }

  const ceremonyId = generateId();
  const options = await generateAuthenticationOptions({
    rpID: config.rpId,
    timeout: PASSKEY_AUTHENTICATION_TIMEOUT_MS,
    userVerification: 'required',
  });

  const challengeHash = hashAuthenticationChallenge({
    hashKey: config.challengeHashKey,
    challengeId: ceremonyId,
    purpose: 'authenticate',
    rpId: config.rpId,
    clientType: input.clientType,
    rawChallenge: options.challenge,
  });

  await createWebAuthnChallenge(db, {
    id: ceremonyId,
    accountId: null,
    purpose: 'authenticate',
    challengeHash,
    createdAt: now,
    expiresAt: addMinutes(now, PASSKEY_AUTHENTICATION_CHALLENGE_TTL_MINUTES),
  });

  await recordPasskeyOptionsAttempt(db, {
    rateLimitHashKey: config.rateLimitHashKey,
    ip: input.ip,
    anonymousClientKey: input.anonymousClientKey,
    now,
    throttled: false,
    requestId: input.requestId ?? null,
  });

  return { authenticationCeremonyId: ceremonyId, options };
}

export type AuthenticationSuccess =
  | { clientType: 'web'; status: 'AUTHENTICATED'; session: AccountSessionRow; rawToken: string }
  | {
      clientType: 'mobile';
      status: 'AUTHENTICATED';
      session: AccountSessionRow;
      rawToken: string;
      sessionExpiresAt: string;
    };

export async function verifyPasskeyAuthentication(
  db: Db,
  deps: PasskeyAuthenticationDeps,
  input: {
    authenticationCeremonyId: string;
    clientType: AccountSessionClientType;
    response: AuthenticationResponseJSON;
    ip: string;
    requestId?: string | null;
  },
): Promise<AuthenticationSuccess> {
  const config = requirePasskeyAuthenticationConfig(deps.env);
  const now = deps.now();
  const generateId = deps.generateId ?? (() => randomUUID());
  const generateToken = deps.generateToken ?? generateSessionToken;

  let credentialSubject = 'unknown';
  let accountIdForEvents: string | null = null;

  const fail = async (category: string): Promise<never> => {
    await recordPasskeyAssertionFailedAttempt(db, {
      rateLimitHashKey: config.rateLimitHashKey,
      ip: input.ip,
      credentialSubject,
      accountId: accountIdForEvents,
      now,
      failureCategory: category,
      requestId: input.requestId ?? null,
    }).catch(() => undefined);
    await appendIdentitySecurityEvent(db, {
      id: generateId(),
      accountId: accountIdForEvents,
      eventType: 'authentication_failed',
      occurredAt: now,
      requestId: input.requestId ?? null,
      metadata: {
        purpose: 'authenticate',
        failureCategory: category,
        clientType: input.clientType,
      },
    }).catch(() => undefined);
    throw new AuthenticationFailedError(category);
  };

  if (input.response.id !== input.response.rawId) {
    return await fail('malformed_assertion');
  }

  let credentialId: Buffer;
  try {
    credentialId = Buffer.from(isoBase64URL.toBuffer(input.response.id));
  } catch {
    return await fail('malformed_credential_id');
  }
  credentialSubject = credentialRateSubject(credentialId);

  if (
    await isPasskeyAssertionThrottled(db, {
      rateLimitHashKey: config.rateLimitHashKey,
      ip: input.ip,
      credentialSubject,
      now,
    })
  ) {
    return await fail('rate_limited_verify');
  }

  const challengeRow = await findWebAuthnChallengeById(db, input.authenticationCeremonyId);
  if (!challengeRow) {
    return await fail('challenge_unknown');
  }
  if (challengeRow.purpose !== 'authenticate') {
    return await fail('challenge_wrong_purpose');
  }
  if (challengeRow.consumedAt !== null) {
    return await fail('challenge_consumed');
  }
  if (challengeRow.revokedAt !== null) {
    return await fail('challenge_revoked');
  }
  if (new Date(now).getTime() >= new Date(challengeRow.expiresAt).getTime()) {
    return await fail('challenge_expired');
  }

  const credential = await findActivePasskeyByCredentialId(db, credentialId);
  if (!credential) {
    return await fail('credential_unknown');
  }
  accountIdForEvents = credential.accountId;

  const account = await findAccountById(db, credential.accountId);
  if (account?.status !== 'active') {
    return await fail('account_not_active');
  }

  const expectedHash = toBuffer(challengeRow.challengeHash);
  let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verification = await verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge: (clientChallenge) =>
        verifyAuthenticationChallengeHash({
          hashKey: config.challengeHashKey,
          challengeId: challengeRow.id,
          purpose: 'authenticate',
          rpId: config.rpId,
          clientType: input.clientType,
          rawChallenge: clientChallenge,
          expectedHash,
        }),
      expectedOrigin: [...config.allowedOrigins],
      expectedRPID: config.rpId,
      requireUserVerification: true,
      credential: {
        id: isoBase64URL.fromBuffer(new Uint8Array(toBuffer(credential.credentialId))),
        publicKey: new Uint8Array(toBuffer(credential.publicKey)),
        // Counter policy is applied below so anomaly events use our generic failure path.
        counter: 0,
        ...(credential.transports !== null
          ? {
              transports: credential.transports as (
                'ble' | 'cable' | 'hybrid' | 'internal' | 'nfc' | 'smart-card' | 'usb'
              )[],
            }
          : {}),
      },
    });
  } catch {
    return await fail('webauthn_verify_failed');
  }

  if (!verification.verified) {
    return await fail('webauthn_not_verified');
  }
  if (!verification.authenticationInfo.userVerified) {
    return await fail('user_verification_missing');
  }

  const newCounter = verification.authenticationInfo.newCounter;
  const counterDecision = evaluateCounterPolicy(credential.signCount, newCounter);
  if (counterDecision === 'anomaly') {
    await appendIdentitySecurityEvent(db, {
      id: generateId(),
      accountId: credential.accountId,
      eventType: 'counter_anomaly_detected',
      occurredAt: now,
      requestId: input.requestId ?? null,
      metadata: { purpose: 'authenticate', failureCategory: 'counter_anomaly' },
    }).catch(() => undefined);
    return await fail('counter_anomaly');
  }

  const backup = resolveBackupState({
    storedBackedUp: credential.backedUp,
    storedBackupEligible: credential.backupEligible,
    credentialDeviceType: verification.authenticationInfo.credentialDeviceType,
    credentialBackedUp: verification.authenticationInfo.credentialBackedUp,
  });

  const sessionId = generateId();
  const rawToken = generateToken();
  const tokenHash = hashSessionToken({
    hashKey: config.sessionTokenHashKey,
    clientType: input.clientType,
    token: rawToken,
  });

  try {
    const session = await db.transaction(async (tx) => {
      const dbTx = tx as unknown as Db;

      const challengeLocked = await dbTx
        .select()
        .from(webauthnChallenges)
        .where(eq(webauthnChallenges.id, challengeRow.id))
        .limit(1)
        .for('update');
      const lockedChallenge = challengeLocked[0];
      if (
        lockedChallenge?.purpose !== 'authenticate' ||
        lockedChallenge.consumedAt !== null ||
        lockedChallenge.revokedAt !== null ||
        new Date(now).getTime() >= new Date(lockedChallenge.expiresAt).getTime()
      ) {
        throw new AuthenticationFailedError('challenge_invalid');
      }

      const clientData = JSON.parse(
        Buffer.from(isoBase64URL.toBuffer(input.response.response.clientDataJSON)).toString('utf8'),
      ) as { challenge?: string };
      if (
        typeof clientData.challenge !== 'string' ||
        !verifyAuthenticationChallengeHash({
          hashKey: config.challengeHashKey,
          challengeId: lockedChallenge.id,
          purpose: 'authenticate',
          rpId: config.rpId,
          clientType: input.clientType,
          rawChallenge: clientData.challenge,
          expectedHash: toBuffer(lockedChallenge.challengeHash),
        })
      ) {
        throw new AuthenticationFailedError('challenge_mismatch');
      }

      const credentialLocked = await dbTx
        .select()
        .from(passkeyCredentials)
        .where(eq(passkeyCredentials.id, credential.id))
        .limit(1)
        .for('update');
      const lockedCredential = credentialLocked[0];
      if (lockedCredential?.revokedAt !== null) {
        throw new AuthenticationFailedError('credential_inactive');
      }
      if (evaluateCounterPolicy(lockedCredential.signCount, newCounter) === 'anomaly') {
        throw new AuthenticationFailedError('counter_anomaly');
      }

      const lockedAccount = await lockAccountById(dbTx, lockedCredential.accountId);
      if (lockedAccount?.status !== 'active') {
        throw new AuthenticationFailedError('account_not_active');
      }

      await updatePasskeyAuthenticationState(dbTx, {
        credentialRowId: lockedCredential.id,
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
            eq(webauthnChallenges.id, lockedChallenge.id),
            isNull(webauthnChallenges.consumedAt),
            isNull(webauthnChallenges.revokedAt),
            gt(webauthnChallenges.expiresAt, now),
          ),
        )
        .returning();
      if (!consumed[0]) {
        throw new AuthenticationFailedError('challenge_consume_failed');
      }

      const created = await createAccountSession(dbTx, {
        id: sessionId,
        accountId: lockedAccount.id,
        tokenHash,
        clientType: input.clientType,
        createdAt: now,
        authenticatedPasskeyId: lockedCredential.id,
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
          purpose: 'authenticate',
          clientType: input.clientType,
          backupState: backup.transition,
        },
      });

      return created;
    });

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
  } catch (error) {
    if (error instanceof AuthenticationFailedError) {
      if (error.failureCategory === 'counter_anomaly') {
        await appendIdentitySecurityEvent(db, {
          id: generateId(),
          accountId: accountIdForEvents,
          eventType: 'counter_anomaly_detected',
          occurredAt: now,
          requestId: input.requestId ?? null,
          metadata: { purpose: 'authenticate', failureCategory: 'counter_anomaly' },
        }).catch(() => undefined);
      }
      return await fail(error.failureCategory);
    }
    return await fail('activation_failed');
  }
}

async function maybeTouchSession(
  db: Db,
  session: AccountSessionRow,
  now: string,
): Promise<AccountSessionRow> {
  const lastSeenMs = new Date(session.lastSeenAt).getTime();
  const nowMs = new Date(now).getTime();
  if (nowMs - lastSeenMs < SESSION_TOUCH_MIN_INTERVAL_MS) {
    return session;
  }
  return touchAccountSession(db, { sessionId: session.id, now });
}

export async function resolveActiveSession(
  db: Db,
  deps: PasskeyAuthenticationDeps,
  input: { clientType: AccountSessionClientType; token: string },
): Promise<AccountSessionRow | null> {
  const config = requireSessionRuntimeConfig(deps.env);
  const now = deps.now();
  const tokenHash = hashSessionToken({
    hashKey: config.sessionTokenHashKey,
    clientType: input.clientType,
    token: input.token,
  });
  try {
    const session = await findActiveAccountSessionByTokenHash(db, { tokenHash, now });
    if (session.clientType !== input.clientType) {
      return null;
    }
    const account = await findAccountById(db, session.accountId);
    if (account?.status !== 'active') {
      return null;
    }
    return await maybeTouchSession(db, session, now);
  } catch {
    return null;
  }
}

export async function rotateCurrentSession(
  db: Db,
  deps: PasskeyAuthenticationDeps,
  input: { clientType: AccountSessionClientType; token: string; requestId?: string | null },
): Promise<AuthenticationSuccess> {
  const config = requireSessionRuntimeConfig(deps.env);
  const now = deps.now();
  const generateId = deps.generateId ?? (() => randomUUID());
  const generateToken = deps.generateToken ?? generateSessionToken;

  const current = await resolveActiveSession(db, deps, {
    clientType: input.clientType,
    token: input.token,
  });
  if (!current) {
    throw new AuthenticationFailedError('session_invalid');
  }

  const newSessionId = generateId();
  const rawToken = generateToken();
  const newTokenHash = hashSessionToken({
    hashKey: config.sessionTokenHashKey,
    clientType: input.clientType,
    token: rawToken,
  });

  const { replacement } = await rotateAccountSession(db, {
    oldSessionId: current.id,
    newSessionId,
    newTokenHash,
    now,
    eventId: generateId(),
    requestId: input.requestId ?? null,
  });

  if (input.clientType === 'web') {
    return { clientType: 'web', status: 'AUTHENTICATED', session: replacement, rawToken };
  }
  return {
    clientType: 'mobile',
    status: 'AUTHENTICATED',
    session: replacement,
    rawToken,
    sessionExpiresAt: replacement.absoluteExpiresAt,
  };
}

export async function logoutCurrentSession(
  db: Db,
  deps: PasskeyAuthenticationDeps,
  input: { clientType: AccountSessionClientType; token: string; requestId?: string | null },
): Promise<{ status: 'SIGNED_OUT' }> {
  const now = deps.now();
  const generateId = deps.generateId ?? (() => randomUUID());
  const current = await resolveActiveSession(db, deps, {
    clientType: input.clientType,
    token: input.token,
  });
  if (current) {
    await revokeAccountSession(db, {
      sessionId: current.id,
      reason: 'logout',
      now,
      eventId: generateId(),
      requestId: input.requestId ?? null,
    });
  }
  return { status: 'SIGNED_OUT' };
}

export async function logoutAllSessions(
  db: Db,
  deps: PasskeyAuthenticationDeps,
  input: { clientType: AccountSessionClientType; token: string; requestId?: string | null },
): Promise<{ status: 'SIGNED_OUT' }> {
  const now = deps.now();
  const generateId = deps.generateId ?? (() => randomUUID());
  const current = await resolveActiveSession(db, deps, {
    clientType: input.clientType,
    token: input.token,
  });
  if (!current) {
    throw new AuthenticationFailedError('session_invalid');
  }
  if (!isSensitiveOperationFresh(current.authenticatedAt, now)) {
    throw new RecentAuthenticationRequiredError();
  }

  await db.transaction(async (tx) => {
    const dbTx = tx as unknown as Db;
    await lockAccountById(dbTx, current.accountId);
    await revokeAllAccountSessions(dbTx, {
      accountId: current.accountId,
      reason: 'logout_all',
      now,
      eventId: generateId(),
      requestId: input.requestId ?? null,
    });
  });

  return { status: 'SIGNED_OUT' };
}

export function sessionIntrospection(
  session: AccountSessionRow | null,
  now: string,
):
  | {
      authenticated: true;
      clientType: AccountSessionClientType;
      sensitiveOperationsFresh: boolean;
      idleExpiresAt: string;
      absoluteExpiresAt: string;
    }
  | { authenticated: false } {
  if (!session) {
    return { authenticated: false };
  }
  return {
    authenticated: true,
    clientType: session.clientType as AccountSessionClientType,
    sensitiveOperationsFresh: isSensitiveOperationFresh(session.authenticatedAt, now),
    idleExpiresAt: session.idleExpiresAt,
    absoluteExpiresAt: session.absoluteExpiresAt,
  };
}

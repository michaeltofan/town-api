import type { Database } from '../../db/client.js';
import { createCivicActor, linkActorToAccount } from '../repositories/actor-link.js';
import {
  createAccountShell,
  ensureWebAuthnUserHandle,
  transitionAccountState,
} from '../repositories/accounts.js';
import {
  createEmailChallenge,
  createWebAuthnChallenge,
  consumeEmailChallenge,
  consumeWebAuthnChallenge,
} from '../repositories/challenges.js';
import { addAccountEmail, verifyEmail } from '../repositories/emails.js';
import { addPasskeyCredential } from '../repositories/passkeys.js';
import { createAccountPasswordCredential } from '../repositories/password-credentials.js';
import { createRecoveryGrant } from '../repositories/recovery-grants.js';
import { appendIdentitySecurityEvent } from '../repositories/security-events.js';
import { normalizeEmail } from '../email-normalize.js';
import { deterministicSha256 } from '../hashing.js';
import { hashPassword } from '../password-hashing.js';
import {
  IDENTITY_ACCOUNT_IDS,
  IDENTITY_ACTOR_IDS,
  IDENTITY_CHALLENGE_IDS,
  IDENTITY_EMAIL_IDS,
  IDENTITY_EVENT_IDS,
  IDENTITY_FIXTURE_COMMUNITY_ID,
  IDENTITY_FIXTURE_EMAILS,
  IDENTITY_FIXTURE_TIMESTAMPS,
  IDENTITY_GRANT_IDS,
  IDENTITY_HASHES,
  IDENTITY_PASSKEY_IDS,
  IDENTITY_PASSWORD_IDS,
} from './content.js';

type Db = Database['db'];

const FIXTURE_PASSWORD = 'fixture-password-15';

async function bootstrapAccountWithEmailPasskeyActor(
  db: Db,
  options: {
    accountId: string;
    emailId: string;
    email: string;
    passwordCredentialId: string;
    passkeyIds: string[];
    credentialIds: Buffer[];
    publicKeys: Buffer[];
    actorId: string;
    actorLabel: string;
    finalStatus: 'active' | 'suspended' | 'closed';
  },
): Promise<void> {
  const { t0, t1, t2, t3, t4 } = IDENTITY_FIXTURE_TIMESTAMPS;
  await createAccountShell(db, { id: options.accountId, createdAt: t0, updatedAt: t0 });
  await addAccountEmail(db, {
    id: options.emailId,
    accountId: options.accountId,
    email: options.email,
    isPrimary: true,
    createdAt: t0,
    updatedAt: t0,
  });
  await verifyEmail(db, { emailId: options.emailId, verifiedAt: t1 });
  await transitionAccountState(db, {
    accountId: options.accountId,
    to: 'pending_password',
    at: t1,
  });
  const password = await hashPassword(FIXTURE_PASSWORD);
  await createAccountPasswordCredential(db, {
    id: options.passwordCredentialId,
    accountId: options.accountId,
    passwordHash: password.hash,
    algorithm: password.algorithm,
    parameters: password.parameters,
    createdAt: t1,
  });
  await transitionAccountState(db, {
    accountId: options.accountId,
    to: 'pending_passkey',
    at: t1,
  });

  for (let index = 0; index < options.passkeyIds.length; index += 1) {
    const passkeyId = options.passkeyIds[index];
    const credentialId = options.credentialIds[index];
    const publicKey = options.publicKeys[index];
    if (passkeyId === undefined || credentialId === undefined || publicKey === undefined) {
      throw new Error('Fixture passkey arrays are misaligned');
    }
    await addPasskeyCredential(db, {
      id: passkeyId,
      accountId: options.accountId,
      credentialId,
      publicKey,
      signCount: 0,
      deviceType: 'platform',
      label: `Fixture passkey ${String(index + 1)}`,
      createdAt: t2,
    });
  }

  await createCivicActor(db, {
    id: options.actorId,
    displayLabel: options.actorLabel,
    communityId: IDENTITY_FIXTURE_COMMUNITY_ID,
    createdAt: t2,
    updatedAt: t2,
  });
  await linkActorToAccount(db, {
    actorId: options.actorId,
    accountId: options.accountId,
    at: t3,
  });
  await ensureWebAuthnUserHandle(db, {
    accountId: options.accountId,
    handle: Buffer.from(deterministicSha256(`fixture-webauthn-handle-${options.accountId}`)),
    now: t3,
  });
  await transitionAccountState(db, {
    accountId: options.accountId,
    to: 'active',
    at: t3,
  });

  if (options.finalStatus === 'suspended') {
    await transitionAccountState(db, {
      accountId: options.accountId,
      to: 'suspended',
      at: t4,
    });
  } else if (options.finalStatus === 'closed') {
    await transitionAccountState(db, {
      accountId: options.accountId,
      to: 'closed',
      at: t4,
    });
  }
}

/**
 * Loads deterministic identity fixtures into an already-migrated database.
 * Does not truncate. Does not modify the controlled test actor.
 * Must never run at application startup.
 */
export async function loadIdentityFixtures(db: Db): Promise<void> {
  const { t0, t1, expiredAt, farFuture } = IDENTITY_FIXTURE_TIMESTAMPS;

  await createAccountShell(db, {
    id: IDENTITY_ACCOUNT_IDS.pendingEmail,
    createdAt: t0,
    updatedAt: t0,
  });
  await addAccountEmail(db, {
    id: IDENTITY_EMAIL_IDS.pendingEmailPrimary,
    accountId: IDENTITY_ACCOUNT_IDS.pendingEmail,
    email: IDENTITY_FIXTURE_EMAILS.pending,
    isPrimary: true,
    createdAt: t0,
    updatedAt: t0,
  });

  await createAccountShell(db, {
    id: IDENTITY_ACCOUNT_IDS.pendingPasskey,
    createdAt: t0,
    updatedAt: t0,
  });
  await addAccountEmail(db, {
    id: IDENTITY_EMAIL_IDS.pendingPasskeyPrimary,
    accountId: IDENTITY_ACCOUNT_IDS.pendingPasskey,
    email: IDENTITY_FIXTURE_EMAILS.pendingPasskey,
    isPrimary: true,
    createdAt: t0,
    updatedAt: t0,
  });
  await verifyEmail(db, {
    emailId: IDENTITY_EMAIL_IDS.pendingPasskeyPrimary,
    verifiedAt: t1,
  });
  await transitionAccountState(db, {
    accountId: IDENTITY_ACCOUNT_IDS.pendingPasskey,
    to: 'pending_password',
    at: t1,
  });
  const pendingPasskeyPassword = await hashPassword(FIXTURE_PASSWORD);
  await createAccountPasswordCredential(db, {
    id: IDENTITY_PASSWORD_IDS.pendingPasskey,
    accountId: IDENTITY_ACCOUNT_IDS.pendingPasskey,
    passwordHash: pendingPasskeyPassword.hash,
    algorithm: pendingPasskeyPassword.algorithm,
    parameters: pendingPasskeyPassword.parameters,
    createdAt: t1,
  });
  await transitionAccountState(db, {
    accountId: IDENTITY_ACCOUNT_IDS.pendingPasskey,
    to: 'pending_passkey',
    at: t1,
  });

  await bootstrapAccountWithEmailPasskeyActor(db, {
    accountId: IDENTITY_ACCOUNT_IDS.active,
    emailId: IDENTITY_EMAIL_IDS.activePrimary,
    email: IDENTITY_FIXTURE_EMAILS.active,
    passwordCredentialId: IDENTITY_PASSWORD_IDS.active,
    passkeyIds: [IDENTITY_PASSKEY_IDS.activeOne, IDENTITY_PASSKEY_IDS.activeTwo],
    credentialIds: [IDENTITY_HASHES.passkeyCredentialOne, IDENTITY_HASHES.passkeyCredentialTwo],
    publicKeys: [IDENTITY_HASHES.passkeyPublicKeyOne, IDENTITY_HASHES.passkeyPublicKeyTwo],
    actorId: IDENTITY_ACTOR_IDS.activeLinked,
    actorLabel: 'Active fixture civic actor',
    finalStatus: 'active',
  });

  await bootstrapAccountWithEmailPasskeyActor(db, {
    accountId: IDENTITY_ACCOUNT_IDS.suspended,
    emailId: IDENTITY_EMAIL_IDS.suspendedPrimary,
    email: IDENTITY_FIXTURE_EMAILS.suspended,
    passwordCredentialId: IDENTITY_PASSWORD_IDS.suspended,
    passkeyIds: [IDENTITY_PASSKEY_IDS.suspendedOne],
    credentialIds: [IDENTITY_HASHES.passkeyCredentialSuspended],
    publicKeys: [IDENTITY_HASHES.passkeyPublicKeySuspended],
    actorId: IDENTITY_ACTOR_IDS.suspendedLinked,
    actorLabel: 'Suspended fixture civic actor',
    finalStatus: 'suspended',
  });

  await bootstrapAccountWithEmailPasskeyActor(db, {
    accountId: IDENTITY_ACCOUNT_IDS.closed,
    emailId: IDENTITY_EMAIL_IDS.closedPrimary,
    email: IDENTITY_FIXTURE_EMAILS.closed,
    passwordCredentialId: IDENTITY_PASSWORD_IDS.closed,
    passkeyIds: [IDENTITY_PASSKEY_IDS.closedOne],
    credentialIds: [IDENTITY_HASHES.passkeyCredentialClosed],
    publicKeys: [IDENTITY_HASHES.passkeyPublicKeyClosed],
    actorId: IDENTITY_ACTOR_IDS.closedLinked,
    actorLabel: 'Closed fixture civic actor',
    finalStatus: 'closed',
  });

  await createEmailChallenge(db, {
    id: IDENTITY_CHALLENGE_IDS.expiredEmail,
    accountId: IDENTITY_ACCOUNT_IDS.pendingEmail,
    emailNormalized: normalizeEmail(IDENTITY_FIXTURE_EMAILS.pending),
    purpose: 'verify_email',
    secretHash: IDENTITY_HASHES.expiredEmailSecret,
    createdAt: expiredAt,
    expiresAt: t0,
  });

  await createEmailChallenge(db, {
    id: IDENTITY_CHALLENGE_IDS.consumedEmail,
    accountId: IDENTITY_ACCOUNT_IDS.pendingPasskey,
    emailNormalized: normalizeEmail(IDENTITY_FIXTURE_EMAILS.pendingPasskey),
    purpose: 'verify_email',
    secretHash: IDENTITY_HASHES.consumedEmailSecret,
    createdAt: t0,
    expiresAt: farFuture,
  });
  await consumeEmailChallenge(db, {
    challengeId: IDENTITY_CHALLENGE_IDS.consumedEmail,
    now: t1,
  });

  await createWebAuthnChallenge(db, {
    id: IDENTITY_CHALLENGE_IDS.expiredWebauthn,
    accountId: IDENTITY_ACCOUNT_IDS.pendingPasskey,
    purpose: 'register',
    challengeHash: IDENTITY_HASHES.expiredWebauthn,
    createdAt: expiredAt,
    expiresAt: t0,
  });

  await createWebAuthnChallenge(db, {
    id: IDENTITY_CHALLENGE_IDS.consumedWebauthn,
    accountId: IDENTITY_ACCOUNT_IDS.active,
    purpose: 'authenticate',
    challengeHash: IDENTITY_HASHES.consumedWebauthn,
    createdAt: t0,
    expiresAt: farFuture,
  });
  await consumeWebAuthnChallenge(db, {
    challengeId: IDENTITY_CHALLENGE_IDS.consumedWebauthn,
    now: t1,
  });

  await createRecoveryGrant(db, {
    id: IDENTITY_GRANT_IDS.restricted,
    accountId: IDENTITY_ACCOUNT_IDS.active,
    tokenHash: IDENTITY_HASHES.recoveryToken,
    createdAt: t0,
    expiresAt: farFuture,
  });

  await appendIdentitySecurityEvent(db, {
    id: IDENTITY_EVENT_IDS.emailRequested,
    accountId: IDENTITY_ACCOUNT_IDS.pendingEmail,
    eventType: 'email_verification_requested',
    occurredAt: t0,
    metadata: { purpose: 'verify_email' },
  });
  await appendIdentitySecurityEvent(db, {
    id: IDENTITY_EVENT_IDS.emailVerified,
    accountId: IDENTITY_ACCOUNT_IDS.pendingPasskey,
    eventType: 'email_verified',
    occurredAt: t1,
    metadata: { emailId: IDENTITY_EMAIL_IDS.pendingPasskeyPrimary },
  });
  await appendIdentitySecurityEvent(db, {
    id: IDENTITY_EVENT_IDS.passkeyRegistered,
    accountId: IDENTITY_ACCOUNT_IDS.active,
    eventType: 'passkey_registered',
    occurredAt: t1,
    metadata: { passkeyId: IDENTITY_PASSKEY_IDS.activeOne },
  });
  await appendIdentitySecurityEvent(db, {
    id: IDENTITY_EVENT_IDS.recoveryRequested,
    accountId: IDENTITY_ACCOUNT_IDS.active,
    eventType: 'recovery_requested',
    occurredAt: t1,
    metadata: { grantId: IDENTITY_GRANT_IDS.restricted },
  });
}

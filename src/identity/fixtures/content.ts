import { FOUNDATION_COMMUNITY_IDS } from '../../db/seeds/foundation-content.js';
import { deterministicSha256 } from '../hashing.js';

/**
 * Deterministic identity fixtures for Account Identity Foundation V1.
 * Fixed UUIDs, timestamps, and byte sequences. Never used at application startup.
 * Uses reserved example domains only.
 */

export const IDENTITY_FIXTURE_TIMESTAMPS = {
  t0: '2026-07-16T10:00:00.000Z',
  t1: '2026-07-16T10:05:00.000Z',
  t2: '2026-07-16T10:10:00.000Z',
  t3: '2026-07-16T10:15:00.000Z',
  t4: '2026-07-16T10:20:00.000Z',
  t5: '2026-07-16T10:25:00.000Z',
  expiredAt: '2026-07-16T09:00:00.000Z',
  farFuture: '2026-07-17T10:00:00.000Z',
} as const;

export const IDENTITY_ACCOUNT_IDS = {
  pendingEmail: '10000000-0000-4000-8000-000000000001',
  pendingPasskey: '10000000-0000-4000-8000-000000000002',
  active: '10000000-0000-4000-8000-000000000003',
  suspended: '10000000-0000-4000-8000-000000000004',
  closed: '10000000-0000-4000-8000-000000000005',
} as const;

export const IDENTITY_EMAIL_IDS = {
  pendingEmailPrimary: '11000000-0000-4000-8000-000000000001',
  pendingPasskeyPrimary: '11000000-0000-4000-8000-000000000002',
  activePrimary: '11000000-0000-4000-8000-000000000003',
  suspendedPrimary: '11000000-0000-4000-8000-000000000004',
  closedPrimary: '11000000-0000-4000-8000-000000000005',
} as const;

export const IDENTITY_PASSKEY_IDS = {
  activeOne: '12000000-0000-4000-8000-000000000001',
  activeTwo: '12000000-0000-4000-8000-000000000002',
  suspendedOne: '12000000-0000-4000-8000-000000000003',
  closedOne: '12000000-0000-4000-8000-000000000004',
} as const;

export const IDENTITY_ACTOR_IDS = {
  activeLinked: '13000000-0000-4000-8000-000000000001',
  suspendedLinked: '13000000-0000-4000-8000-000000000002',
  closedLinked: '13000000-0000-4000-8000-000000000003',
} as const;

export const IDENTITY_CHALLENGE_IDS = {
  expiredEmail: '14000000-0000-4000-8000-000000000001',
  consumedEmail: '14000000-0000-4000-8000-000000000002',
  expiredWebauthn: '14000000-0000-4000-8000-000000000003',
  consumedWebauthn: '14000000-0000-4000-8000-000000000004',
} as const;

export const IDENTITY_GRANT_IDS = {
  restricted: '15000000-0000-4000-8000-000000000001',
} as const;

export const IDENTITY_EVENT_IDS = {
  emailRequested: '16000000-0000-4000-8000-000000000001',
  emailVerified: '16000000-0000-4000-8000-000000000002',
  passkeyRegistered: '16000000-0000-4000-8000-000000000003',
  recoveryRequested: '16000000-0000-4000-8000-000000000004',
} as const;

export const IDENTITY_HASHES = {
  expiredEmailSecret: deterministicSha256('fixture-email-challenge-expired'),
  consumedEmailSecret: deterministicSha256('fixture-email-challenge-consumed'),
  expiredWebauthn: deterministicSha256('fixture-webauthn-challenge-expired'),
  consumedWebauthn: deterministicSha256('fixture-webauthn-challenge-consumed'),
  recoveryToken: deterministicSha256('fixture-recovery-grant-token'),
  passkeyCredentialOne: Buffer.from('fixture-passkey-credential-id-01', 'utf8'),
  passkeyCredentialTwo: Buffer.from('fixture-passkey-credential-id-02', 'utf8'),
  passkeyCredentialSuspended: Buffer.from('fixture-passkey-credential-id-03', 'utf8'),
  passkeyCredentialClosed: Buffer.from('fixture-passkey-credential-id-04', 'utf8'),
  passkeyPublicKeyOne: Buffer.from('fixture-passkey-public-key-01', 'utf8'),
  passkeyPublicKeyTwo: Buffer.from('fixture-passkey-public-key-02', 'utf8'),
  passkeyPublicKeySuspended: Buffer.from('fixture-passkey-public-key-03', 'utf8'),
  passkeyPublicKeyClosed: Buffer.from('fixture-passkey-public-key-04', 'utf8'),
} as const;

export const IDENTITY_FIXTURE_EMAILS = {
  pending: 'Pending.User+signup@example.com',
  pendingPasskey: 'Verified.User+passkey@example.org',
  active: 'Active.Owner+main@example.net',
  suspended: 'Suspended.User+hold@example.com',
  closed: 'Closed.User+archive@example.org',
} as const;

export const IDENTITY_FIXTURE_COMMUNITY_ID = FOUNDATION_COMMUNITY_IDS.milanoIt;

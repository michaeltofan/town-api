import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { count, eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { createDatabase, type Database } from '../src/db/client.js';
import { actors, passkeyCredentials, signalConfirmations } from '../src/db/schema.js';
import { CONTROLLED_TEST_ACTOR_ID } from '../src/db/seeds/controlled-actor-content.js';
import { FOUNDATION_COMMUNITY_IDS } from '../src/db/seeds/foundation-content.js';
import { IdentityInvariantError } from '../src/identity/errors.js';
import { normalizeEmail } from '../src/identity/email-normalize.js';
import { deterministicSha256 } from '../src/identity/hashing.js';
import {
  createAccountShell,
  ensureWebAuthnUserHandle,
  findAccountById,
  transitionAccountState,
} from '../src/identity/repositories/accounts.js';
import { createCivicActor, linkActorToAccount } from '../src/identity/repositories/actor-link.js';
import {
  consumeEmailChallenge,
  consumeWebAuthnChallenge,
  createEmailChallenge,
  createWebAuthnChallenge,
} from '../src/identity/repositories/challenges.js';
import {
  addAccountEmail,
  findActiveEmailByNormalized,
  findCanonicalEmailByNormalized,
  revokeEmail,
  setPrimaryEmail,
  verifyEmail,
} from '../src/identity/repositories/emails.js';
import {
  addPasskeyCredential,
  listActivePasskeys,
  revokePasskey,
  updateSignCount,
} from '../src/identity/repositories/passkeys.js';
import { createAccountPasswordCredential } from '../src/identity/repositories/password-credentials.js';
import { hashPassword } from '../src/identity/password-hashing.js';
import {
  consumeRecoveryGrant,
  createRecoveryGrant,
} from '../src/identity/repositories/recovery-grants.js';
import {
  appendIdentitySecurityEvent,
  listIdentitySecurityEventsForAccount,
} from '../src/identity/repositories/security-events.js';
import { toIsoTimestamp } from '../src/lib/timestamps.js';
import { requireDatabaseUrl, resetMigrateSeedFoundationAndActor } from './helpers/pg.js';

const T0 = '2026-07-16T12:00:00.000Z';
const T1 = '2026-07-16T12:05:00.000Z';
const T2 = '2026-07-16T12:10:00.000Z';
const T3 = '2026-07-16T12:15:00.000Z';
const FUTURE = '2026-07-17T12:00:00.000Z';

describe('account identity repositories', () => {
  const databaseUrl = requireDatabaseUrl();
  let pool: Pool;
  let database: Database | undefined;

  beforeAll(() => {
    pool = new Pool({ connectionString: databaseUrl, max: 1 });
  });

  beforeEach(async () => {
    if (database !== undefined) {
      await database.close();
    }
    await resetMigrateSeedFoundationAndActor(pool);
    database = createDatabase({
      connectionString: databaseUrl,
      poolMax: 5,
      connectionTimeoutMs: 3000,
      idleTimeoutMs: 1000,
    });
  });

  afterAll(async () => {
    if (database !== undefined) {
      await database.close();
    }
    await pool.end();
  });

  function db(): Database['db'] {
    if (database === undefined) {
      throw new Error('Database not initialized');
    }
    return database.db;
  }

  async function prepareActiveReadyAccount(accountId: string): Promise<{
    emailId: string;
    passkeyId: string;
    actorId: string;
  }> {
    const suffix = accountId.replace(/-/g, '').slice(-12);
    const emailId = `21000000-0000-4000-8000-${suffix}`;
    const passkeyId = `22000000-0000-4000-8000-${suffix}`;
    const actorId = `23000000-0000-4000-8000-${suffix}`;

    const existing = await findAccountById(db(), accountId);
    if (!existing) {
      await createAccountShell(db(), { id: accountId, createdAt: T0, updatedAt: T0 });
    }

    await addAccountEmail(db(), {
      id: emailId,
      accountId,
      email: `Ready.User+${suffix}@example.com`,
      isPrimary: true,
      createdAt: T0,
      updatedAt: T0,
    });
    await verifyEmail(db(), { emailId, verifiedAt: T1 });
    await transitionAccountState(db(), {
      accountId,
      to: 'pending_password',
      at: T1,
    });
    const password = await hashPassword('test-password-15chars');
    await createAccountPasswordCredential(db(), {
      id: `24000000-0000-4000-8000-${suffix}`,
      accountId,
      passwordHash: password.hash,
      algorithm: password.algorithm,
      parameters: password.parameters,
      createdAt: T1,
    });
    await transitionAccountState(db(), {
      accountId,
      to: 'pending_passkey',
      at: T1,
    });
    await addPasskeyCredential(db(), {
      id: passkeyId,
      accountId,
      credentialId: Buffer.from(`ready-credential-${suffix}`),
      publicKey: Buffer.from(`ready-public-key-${suffix}`),
      signCount: 1,
      createdAt: T2,
    });
    await createCivicActor(db(), {
      id: actorId,
      displayLabel: 'Ready civic actor',
      communityId: FOUNDATION_COMMUNITY_IDS.milanoIt,
      createdAt: T2,
      updatedAt: T2,
    });
    await linkActorToAccount(db(), { actorId, accountId, at: T2 });
    await ensureWebAuthnUserHandle(db(), {
      accountId,
      handle: deterministicSha256(`test-webauthn-handle-${accountId}`),
      now: T2,
    });
    return { emailId, passkeyId, actorId };
  }

  it('enforces account lifecycle transitions and active requirements', async () => {
    const accountId = '20000000-0000-4000-8000-000000000001';
    await createAccountShell(db(), { id: accountId, createdAt: T0, updatedAt: T0 });

    await expect(
      transitionAccountState(db(), { accountId, to: 'active', at: T1 }),
    ).rejects.toMatchObject({
      code: 'INVALID_ACCOUNT_TRANSITION',
    } satisfies Partial<IdentityInvariantError>);

    await prepareActiveReadyAccount(accountId);
    const active = await transitionAccountState(db(), {
      accountId,
      to: 'active',
      at: T3,
    });
    expect(active.status).toBe('active');
    expect(active.accountReadyAt).toBeTruthy();
    expect(toIsoTimestamp(String(active.accountReadyAt))).toBe(T3);

    const suspended = await transitionAccountState(db(), {
      accountId,
      to: 'suspended',
      at: FUTURE,
    });
    expect(suspended.status).toBe('suspended');
    expect(suspended.suspendedAt).toBeTruthy();
    expect(toIsoTimestamp(String(suspended.suspendedAt))).toBe(FUTURE);

    const reactivated = await transitionAccountState(db(), {
      accountId,
      to: 'active',
      at: '2026-07-17T13:00:00.000Z',
    });
    expect(reactivated.status).toBe('active');
    expect(reactivated.suspendedAt).toBeNull();

    const closed = await transitionAccountState(db(), {
      accountId,
      to: 'closed',
      at: '2026-07-17T14:00:00.000Z',
    });
    expect(closed.status).toBe('closed');
    expect(closed.closedAt).toBeTruthy();
    expect(toIsoTimestamp(String(closed.closedAt))).toBe('2026-07-17T14:00:00.000Z');

    await expect(
      transitionAccountState(db(), {
        accountId,
        to: 'active',
        at: '2026-07-17T15:00:00.000Z',
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_ACCOUNT_TRANSITION',
    } satisfies Partial<IdentityInvariantError>);
  });

  it('enforces email normalization, uniqueness, primary, and revoke rules', async () => {
    const accountId = '20000000-0000-4000-8000-000000000002';
    await createAccountShell(db(), { id: accountId, createdAt: T0, updatedAt: T0 });
    const email = await addAccountEmail(db(), {
      id: '21000000-0000-4000-8000-000000000010',
      accountId,
      email: '  Owner.Name+tag@Example.COM ',
      isPrimary: true,
      createdAt: T0,
      updatedAt: T0,
    });
    expect(email.emailNormalized).toBe('Owner.Name+tag@example.com');
    expect(email.emailOriginal).toBe('Owner.Name+tag@Example.COM');

    await expect(
      addAccountEmail(db(), {
        id: '21000000-0000-4000-8000-000000000011',
        accountId,
        email: 'Owner.Name+tag@EXAMPLE.com',
        isPrimary: false,
        createdAt: T1,
        updatedAt: T1,
      }),
    ).rejects.toMatchObject({
      code: 'EMAIL_ALREADY_ACTIVE',
    } satisfies Partial<IdentityInvariantError>);

    // Different local-part form remains distinct (no provider rewriting).
    await addAccountEmail(db(), {
      id: '21000000-0000-4000-8000-000000000012',
      accountId,
      email: 'ownername+tag@example.com',
      isPrimary: false,
      createdAt: T1,
      updatedAt: T1,
    });

    await createAccountShell(db(), {
      id: '20000000-0000-4000-8000-000000000099',
      createdAt: T0,
      updatedAt: T0,
    });
    const secondary = await addAccountEmail(db(), {
      id: '21000000-0000-4000-8000-000000000013',
      accountId: '20000000-0000-4000-8000-000000000099',
      email: 'second@example.org',
      isPrimary: true,
      createdAt: T1,
      updatedAt: T1,
    });
    expect(secondary.isPrimary).toBe(true);

    await setPrimaryEmail(db(), {
      accountId,
      emailId: '21000000-0000-4000-8000-000000000012',
      at: T2,
    });
    const found = await findActiveEmailByNormalized(
      db(),
      normalizeEmail('ownername+tag@example.com'),
    );
    expect(found?.isPrimary).toBe(true);

    const revoked = await revokeEmail(db(), {
      emailId: '21000000-0000-4000-8000-000000000012',
      revokedAt: T3,
    });
    expect(revoked.revokedAt).toBeTruthy();
    expect(toIsoTimestamp(String(revoked.revokedAt))).toBe(T3);
    expect(revoked.isPrimary).toBe(false);
    expect(
      await findActiveEmailByNormalized(db(), normalizeEmail('ownername+tag@example.com')),
    ).toBeNull();

    // Permanent exact ownership: a revoked email_normalized cannot be attached to
    // another account, and historical ownership remains inspectable.
    await expect(
      addAccountEmail(db(), {
        id: '21000000-0000-4000-8000-000000000014',
        accountId: '20000000-0000-4000-8000-000000000099',
        email: 'ownername+tag@example.com',
        isPrimary: false,
        createdAt: T3,
        updatedAt: T3,
      }),
    ).rejects.toMatchObject({
      code: 'EMAIL_ALREADY_ACTIVE',
    } satisfies Partial<IdentityInvariantError>);

    const historical = await findCanonicalEmailByNormalized(
      db(),
      normalizeEmail('ownername+tag@example.com'),
    );
    expect(historical?.accountId).toBe(accountId);
    expect(historical?.revokedAt).toBeTruthy();

    // Same account cannot accumulate a second row for the same exact normalized email.
    await expect(
      addAccountEmail(db(), {
        id: '21000000-0000-4000-8000-000000000015',
        accountId,
        email: 'ownername+tag@EXAMPLE.com',
        isPrimary: false,
        createdAt: T3,
        updatedAt: T3,
      }),
    ).rejects.toMatchObject({
      code: 'EMAIL_ALREADY_ACTIVE',
    } satisfies Partial<IdentityInvariantError>);
  });

  it('supports multiple passkeys and protects the final active passkey', async () => {
    const accountId = '20000000-0000-4000-8000-000000000003';
    const { passkeyId } = await prepareActiveReadyAccount(accountId);
    await transitionAccountState(db(), { accountId, to: 'active', at: T3 });

    await expect(
      revokePasskey(db(), { credentialRowId: passkeyId, revokedAt: FUTURE }),
    ).rejects.toMatchObject({
      code: 'FINAL_PASSKEY_PROTECTED',
    } satisfies Partial<IdentityInvariantError>);

    const secondId = '22000000-0000-4000-8000-000000000002';
    await addPasskeyCredential(db(), {
      id: secondId,
      accountId,
      credentialId: Buffer.from('ready-credential-2'),
      publicKey: Buffer.from('ready-public-key-2'),
      signCount: 0,
      createdAt: FUTURE,
    });

    await expect(
      addPasskeyCredential(db(), {
        id: '22000000-0000-4000-8000-00000000aaaa',
        accountId,
        credentialId: Buffer.from(`ready-credential-${accountId.replace(/-/g, '').slice(-12)}`),
        publicKey: Buffer.from('ready-public-key-3'),
        signCount: 0,
        createdAt: FUTURE,
      }),
    ).rejects.toMatchObject({
      code: 'DUPLICATE_CREDENTIAL_ID',
    } satisfies Partial<IdentityInvariantError>);

    await revokePasskey(db(), { credentialRowId: passkeyId, revokedAt: FUTURE });
    const active = await listActivePasskeys(db(), accountId);
    expect(active).toHaveLength(1);
    expect(active[0]?.id).toBe(secondId);

    await updateSignCount(db(), {
      credentialRowId: secondId,
      signCount: 5,
      lastUsedAt: FUTURE,
    });
    await expect(
      updateSignCount(db(), {
        credentialRowId: secondId,
        signCount: 4,
        lastUsedAt: FUTURE,
      }),
    ).rejects.toMatchObject({
      code: 'SIGN_COUNT_DECREASE_REJECTED',
    } satisfies Partial<IdentityInvariantError>);

    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'town' AND table_name = 'passkey_credentials'`,
    );
    expect(columns.rows.map((row) => row.column_name)).not.toContain('private_key');
    expect((await db().select({ value: count() }).from(passkeyCredentials))[0]?.value).toBe(2);
  });

  it('links civic actors 1:1 and preserves controlled actor plus confirmations', async () => {
    const accountId = '20000000-0000-4000-8000-000000000004';
    await prepareActiveReadyAccount(accountId);

    await expect(
      linkActorToAccount(db(), {
        actorId: CONTROLLED_TEST_ACTOR_ID,
        accountId,
        at: T3,
      }),
    ).rejects.toMatchObject({
      code: 'CONTROLLED_ACTOR_CANNOT_LINK',
    } satisfies Partial<IdentityInvariantError>);

    const controlled = await db()
      .select()
      .from(actors)
      .where(eq(actors.id, CONTROLLED_TEST_ACTOR_ID));
    expect(controlled[0]?.accountId).toBeNull();

    const confirmationCount = await db().select({ value: count() }).from(signalConfirmations);
    expect(confirmationCount[0]?.value).toBe(0);

    const otherAccount = '20000000-0000-4000-8000-000000000005';
    await createAccountShell(db(), { id: otherAccount, createdAt: T0, updatedAt: T0 });
    const otherActor = await createCivicActor(db(), {
      id: '23000000-0000-4000-8000-000000000099',
      displayLabel: 'Other civic actor',
      communityId: FOUNDATION_COMMUNITY_IDS.munichDe,
      createdAt: T0,
      updatedAt: T0,
    });
    await linkActorToAccount(db(), {
      actorId: otherActor.id,
      accountId: otherAccount,
      at: T1,
    });
    await expect(
      linkActorToAccount(db(), {
        actorId: otherActor.id,
        accountId,
        at: T2,
      }),
    ).rejects.toMatchObject({
      code: 'ACTOR_ALREADY_LINKED',
    } satisfies Partial<IdentityInvariantError>);
  });

  it('rejects expired/consumed challenges and recovery grants; stores only hashes', async () => {
    const accountId = '20000000-0000-4000-8000-000000000006';
    await createAccountShell(db(), { id: accountId, createdAt: T0, updatedAt: T0 });

    const emailChallenge = await createEmailChallenge(db(), {
      id: '24000000-0000-4000-8000-000000000001',
      accountId,
      emailNormalized: 'challenge@example.com',
      purpose: 'verify_email',
      secretHash: deterministicSha256('email-secret'),
      createdAt: T0,
      expiresAt: T1,
    });
    expect(Buffer.isBuffer(emailChallenge.secretHash)).toBe(true);

    await expect(
      consumeEmailChallenge(db(), {
        challengeId: emailChallenge.id,
        now: T2,
      }),
    ).rejects.toMatchObject({
      code: 'CHALLENGE_EXPIRED',
    } satisfies Partial<IdentityInvariantError>);

    const liveEmail = await createEmailChallenge(db(), {
      id: '24000000-0000-4000-8000-000000000002',
      accountId,
      emailNormalized: 'challenge2@example.com',
      purpose: 'recover_account',
      secretHash: deterministicSha256('email-secret-2'),
      createdAt: T0,
      expiresAt: FUTURE,
    });
    await consumeEmailChallenge(db(), { challengeId: liveEmail.id, now: T1 });
    await expect(
      consumeEmailChallenge(db(), { challengeId: liveEmail.id, now: T2 }),
    ).rejects.toMatchObject({
      code: 'CHALLENGE_ALREADY_CONSUMED',
    } satisfies Partial<IdentityInvariantError>);

    const webauthn = await createWebAuthnChallenge(db(), {
      id: '24000000-0000-4000-8000-000000000003',
      accountId,
      purpose: 'register',
      challengeHash: deterministicSha256('webauthn-challenge'),
      createdAt: T0,
      expiresAt: T1,
    });
    await expect(
      consumeWebAuthnChallenge(db(), { challengeId: webauthn.id, now: T2 }),
    ).rejects.toMatchObject({
      code: 'CHALLENGE_EXPIRED',
    } satisfies Partial<IdentityInvariantError>);

    const grant = await createRecoveryGrant(db(), {
      id: '25000000-0000-4000-8000-000000000001',
      accountId,
      tokenHash: deterministicSha256('recovery-token'),
      createdAt: T0,
      expiresAt: FUTURE,
    });
    await consumeRecoveryGrant(db(), {
      grantId: grant.id,
      now: T1,
      eventId: '26000000-0000-4000-8000-000000000001',
    });
    await expect(
      consumeRecoveryGrant(db(), {
        grantId: grant.id,
        now: T2,
        eventId: '26000000-0000-4000-8000-000000000002',
      }),
    ).rejects.toMatchObject({
      code: 'GRANT_ALREADY_CONSUMED',
    } satisfies Partial<IdentityInvariantError>);

    const events = await listIdentitySecurityEventsForAccount(db(), accountId);
    expect(events.some((event) => event.eventType === 'recovery_completed')).toBe(false);

    await appendIdentitySecurityEvent(db(), {
      id: '26000000-0000-4000-8000-000000000001',
      accountId,
      eventType: 'recovery_completed',
      occurredAt: T1,
      metadata: { grantId: grant.id },
    });
    const eventsAfter = await listIdentitySecurityEventsForAccount(db(), accountId);
    expect(eventsAfter.some((event) => event.eventType === 'recovery_completed')).toBe(true);

    await expect(
      appendIdentitySecurityEvent(db(), {
        id: '26000000-0000-4000-8000-000000000099',
        accountId,
        eventType: 'not_a_real_event' as never,
        occurredAt: T2,
      }),
    ).rejects.toMatchObject({
      code: 'UNKNOWN_SECURITY_EVENT_TYPE',
    } satisfies Partial<IdentityInvariantError>);

    await expect(
      appendIdentitySecurityEvent(db(), {
        id: '26000000-0000-4000-8000-000000000098',
        accountId,
        eventType: 'email_verified',
        occurredAt: T2,
        metadata: { token: 'raw-secret' },
      }),
    ).rejects.toThrow(/forbidden field/);

    expect(await findAccountById(db(), accountId)).not.toBeNull();
  });
});

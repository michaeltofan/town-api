import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, count, eq, isNull, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { CeremonyInvariantError } from '../src/ceremony/errors.js';
import {
  addMinutes,
  computeAbsoluteExpiresAt,
  computeIdleExpiresAt,
  computeSetupGrantExpiresAt,
} from '../src/ceremony/policy.js';
import {
  assertAuthenticatedAtUnchangedByTouch,
  createAccountSession,
  findActiveAccountSessionByTokenHash,
  listActiveAccountSessionsForAccount,
  rotateAccountSession,
  revokeAccountSession,
  revokeAllAccountSessions,
  revokeAllOtherAccountSessions,
  sessionSupportsSensitiveOperation,
  touchAccountSession,
} from '../src/ceremony/repositories/account-sessions.js';
import {
  getCeremonyRateLimitCount,
  getOrCreateCeremonyRateLimitBucket,
  incrementCeremonyRateLimit,
  isCeremonyRateLimitBlocked,
  resetCeremonyRateLimitForTests,
  setCeremonyRateLimitBlockedUntil,
} from '../src/ceremony/repositories/ceremony-rate-limits.js';
import {
  consumeSetupGrant,
  createSetupGrant,
  findActiveSetupGrantByTokenHash,
  revokeSetupGrant,
} from '../src/ceremony/repositories/setup-grants.js';
import { createDatabase, type Database } from '../src/db/client.js';
import {
  accountSessions,
  actors,
  identitySecurityEvents,
  recoveryGrants,
  setupGrants,
} from '../src/db/schema.js';
import { FOUNDATION_COMMUNITY_IDS } from '../src/db/seeds/foundation-content.js';
import { IdentityInvariantError } from '../src/identity/errors.js';
import { deterministicSha256 } from '../src/identity/hashing.js';
import { createCivicActor, linkActorToAccount } from '../src/identity/repositories/actor-link.js';
import {
  createAccountShell,
  transitionAccountState,
} from '../src/identity/repositories/accounts.js';
import { addAccountEmail, verifyEmail } from '../src/identity/repositories/emails.js';
import { addPasskeyCredential } from '../src/identity/repositories/passkeys.js';
import { createRecoveryGrant } from '../src/identity/repositories/recovery-grants.js';
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

describe('authentication ceremony repositories', () => {
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

  async function preparePendingPasskeyAccount(accountId: string): Promise<string> {
    const suffix = accountId.replace(/-/g, '').slice(-12);
    const emailId = `31000000-0000-4000-8000-${suffix}`;
    await createAccountShell(db(), { id: accountId, createdAt: T0, updatedAt: T0 });
    await addAccountEmail(db(), {
      id: emailId,
      accountId,
      email: `Pending.Passkey+${suffix}@example.com`,
      isPrimary: true,
      createdAt: T0,
      updatedAt: T0,
    });
    await verifyEmail(db(), { emailId, verifiedAt: T1 });
    await transitionAccountState(db(), {
      accountId,
      to: 'pending_passkey',
      at: T1,
    });
    return emailId;
  }

  async function prepareActiveAccount(accountId: string): Promise<{
    emailId: string;
    passkeyId: string;
    actorId: string;
  }> {
    const suffix = accountId.replace(/-/g, '').slice(-12);
    const emailId = `32000000-0000-4000-8000-${suffix}`;
    const passkeyId = `33000000-0000-4000-8000-${suffix}`;
    const actorId = `34000000-0000-4000-8000-${suffix}`;

    await createAccountShell(db(), { id: accountId, createdAt: T0, updatedAt: T0 });
    await addAccountEmail(db(), {
      id: emailId,
      accountId,
      email: `Active.Session+${suffix}@example.com`,
      isPrimary: true,
      createdAt: T0,
      updatedAt: T0,
    });
    await verifyEmail(db(), { emailId, verifiedAt: T1 });
    await transitionAccountState(db(), {
      accountId,
      to: 'pending_passkey',
      at: T1,
    });
    await addPasskeyCredential(db(), {
      id: passkeyId,
      accountId,
      credentialId: Buffer.from(`cred-${suffix}`, 'utf8'),
      publicKey: Buffer.from(`pub-${suffix}`, 'utf8'),
      signCount: 0,
      deviceType: 'platform',
      createdAt: T2,
    });
    await createCivicActor(db(), {
      id: actorId,
      displayLabel: `Session actor ${suffix}`,
      communityId: FOUNDATION_COMMUNITY_IDS.milanoIt,
      createdAt: T2,
      updatedAt: T2,
    });
    await linkActorToAccount(db(), { actorId, accountId, at: T3 });
    await transitionAccountState(db(), { accountId, to: 'active', at: T3 });
    return { emailId, passkeyId, actorId };
  }

  describe('setup grants', () => {
    it('finds active grants and rejects expired, consumed, revoked, wrong purpose/account', async () => {
      const accountId = '30000000-0000-4000-8000-000000000001';
      const otherAccountId = '30000000-0000-4000-8000-000000000002';
      await preparePendingPasskeyAccount(accountId);
      await preparePendingPasskeyAccount(otherAccountId);

      const activeHash = deterministicSha256('setup-active');
      await createSetupGrant(db(), {
        id: '35000000-0000-4000-8000-000000000001',
        accountId,
        tokenHash: activeHash,
        purpose: 'initial_passkey_registration',
        createdAt: T2,
        expiresAt: computeSetupGrantExpiresAt(T2),
      });

      const found = await findActiveSetupGrantByTokenHash(db(), {
        tokenHash: activeHash,
        purpose: 'initial_passkey_registration',
        now: T2,
      });
      expect(found.accountId).toBe(accountId);

      await expect(
        findActiveSetupGrantByTokenHash(db(), {
          tokenHash: activeHash,
          purpose: 'initial_passkey_registration',
          accountId: otherAccountId,
          now: T2,
        }),
      ).rejects.toMatchObject({ code: 'SETUP_GRANT_WRONG_ACCOUNT' });

      await expect(
        findActiveSetupGrantByTokenHash(db(), {
          tokenHash: activeHash,
          purpose: 'initial_passkey_registration' as const,
          now: addMinutes(T2, 16),
        }),
      ).rejects.toMatchObject({ code: 'SETUP_GRANT_EXPIRED' });

      await consumeSetupGrant(db(), {
        grantId: found.id,
        accountId,
        purpose: 'initial_passkey_registration',
        now: T2,
      });
      await expect(
        findActiveSetupGrantByTokenHash(db(), {
          tokenHash: activeHash,
          purpose: 'initial_passkey_registration',
          now: T2,
        }),
      ).rejects.toMatchObject({ code: 'SETUP_GRANT_CONSUMED' });

      const revokedHash = deterministicSha256('setup-revoked');
      await createSetupGrant(db(), {
        id: '35000000-0000-4000-8000-000000000002',
        accountId,
        tokenHash: revokedHash,
        purpose: 'initial_passkey_registration',
        createdAt: T2,
        expiresAt: FUTURE,
      });
      await revokeSetupGrant(db(), {
        grantId: '35000000-0000-4000-8000-000000000002',
        now: T2,
      });
      await expect(
        findActiveSetupGrantByTokenHash(db(), {
          tokenHash: revokedHash,
          purpose: 'initial_passkey_registration',
          now: T2,
        }),
      ).rejects.toMatchObject({ code: 'SETUP_GRANT_REVOKED' });

      const columns = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'town' AND table_name = 'setup_grants'`,
      );
      expect(columns.rows.map((row) => row.column_name)).not.toContain('token');
    });

    it('rejects pending_email and active accounts for setup grants', async () => {
      const pendingEmailId = '30000000-0000-4000-8000-000000000003';
      const activeId = '30000000-0000-4000-8000-000000000004';
      await createAccountShell(db(), { id: pendingEmailId, createdAt: T0, updatedAt: T0 });
      await prepareActiveAccount(activeId);

      await expect(
        createSetupGrant(db(), {
          id: '35000000-0000-4000-8000-000000000003',
          accountId: pendingEmailId,
          tokenHash: deterministicSha256('setup-pending-email'),
          purpose: 'initial_passkey_registration',
          createdAt: T2,
          expiresAt: FUTURE,
        }),
      ).rejects.toMatchObject({ code: 'SETUP_GRANT_REQUIRES_PENDING_PASSKEY' });

      await expect(
        createSetupGrant(db(), {
          id: '35000000-0000-4000-8000-000000000004',
          accountId: activeId,
          tokenHash: deterministicSha256('setup-active-account'),
          purpose: 'initial_passkey_registration',
          createdAt: T2,
          expiresAt: FUTURE,
        }),
      ).rejects.toMatchObject({ code: 'SETUP_GRANT_REQUIRES_PENDING_PASSKEY' });
    });

    it('allows exactly one concurrent successful consumption', async () => {
      const accountId = '30000000-0000-4000-8000-000000000005';
      await preparePendingPasskeyAccount(accountId);
      const grantId = '35000000-0000-4000-8000-000000000005';
      await createSetupGrant(db(), {
        id: grantId,
        accountId,
        tokenHash: deterministicSha256('setup-concurrent'),
        purpose: 'initial_passkey_registration',
        createdAt: T2,
        expiresAt: FUTURE,
      });

      const results = await Promise.allSettled([
        consumeSetupGrant(db(), {
          grantId,
          accountId,
          purpose: 'initial_passkey_registration',
          now: T2,
        }),
        consumeSetupGrant(db(), {
          grantId,
          accountId,
          purpose: 'initial_passkey_registration',
          now: T3,
        }),
      ]);

      const fulfilled = results.filter((result) => result.status === 'fulfilled');
      const rejected = results.filter((result) => result.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      const rejectedResult = rejected[0];
      expect(rejectedResult?.status).toBe('rejected');
      if (rejectedResult?.status === 'rejected') {
        expect(rejectedResult.reason).toBeInstanceOf(CeremonyInvariantError);
      }

      const rows = await db().select().from(setupGrants).where(eq(setupGrants.id, grantId));
      expect(rows[0]?.consumedAt).not.toBeNull();
    });
  });

  describe('account sessions', () => {
    it('creates sessions only for eligible active accounts', async () => {
      const activeId = '30000000-0000-4000-8000-000000000011';
      const pendingId = '30000000-0000-4000-8000-000000000012';
      const suspendedId = '30000000-0000-4000-8000-000000000013';
      const closedId = '30000000-0000-4000-8000-000000000014';
      await prepareActiveAccount(activeId);
      await preparePendingPasskeyAccount(pendingId);
      await prepareActiveAccount(suspendedId);
      await transitionAccountState(db(), { accountId: suspendedId, to: 'suspended', at: T3 });
      await prepareActiveAccount(closedId);
      await transitionAccountState(db(), { accountId: closedId, to: 'closed', at: T3 });

      const session = await createAccountSession(db(), {
        id: '36000000-0000-4000-8000-000000000001',
        accountId: activeId,
        tokenHash: deterministicSha256('session-ok'),
        clientType: 'web',
        createdAt: T3,
        eventId: '37000000-0000-4000-8000-000000000001',
      });
      expect(toIsoTimestamp(session.idleExpiresAt)).toBe(
        computeIdleExpiresAt(T3, computeAbsoluteExpiresAt(T3)),
      );
      expect(toIsoTimestamp(session.absoluteExpiresAt)).toBe(computeAbsoluteExpiresAt(T3));

      await expect(
        createAccountSession(db(), {
          id: '36000000-0000-4000-8000-000000000002',
          accountId: pendingId,
          tokenHash: deterministicSha256('session-pending'),
          clientType: 'web',
          createdAt: T3,
        }),
      ).rejects.toMatchObject({ code: 'SESSION_REQUIRES_ACTIVE_ACCOUNT' });

      await expect(
        createAccountSession(db(), {
          id: '36000000-0000-4000-8000-000000000003',
          accountId: suspendedId,
          tokenHash: deterministicSha256('session-suspended'),
          clientType: 'web',
          createdAt: T3,
        }),
      ).rejects.toMatchObject({ code: 'SESSION_ACCOUNT_SUSPENDED' });

      await expect(
        createAccountSession(db(), {
          id: '36000000-0000-4000-8000-000000000004',
          accountId: closedId,
          tokenHash: deterministicSha256('session-closed'),
          clientType: 'web',
          createdAt: T3,
        }),
      ).rejects.toMatchObject({ code: 'SESSION_ACCOUNT_CLOSED' });

      const columns = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'town' AND table_name = 'account_sessions'`,
      );
      expect(columns.rows.map((row) => row.column_name)).not.toContain('token');
    });

    it('rejects accounts without verified email, passkey, or linked actor', async () => {
      const noEmailVerified = '30000000-0000-4000-8000-000000000015';
      await createAccountShell(db(), { id: noEmailVerified, createdAt: T0, updatedAt: T0 });
      await addAccountEmail(db(), {
        id: '32000000-0000-4000-8000-000000000015',
        accountId: noEmailVerified,
        email: 'Unverified.User+session@example.com',
        isPrimary: true,
        createdAt: T0,
        updatedAt: T0,
      });
      // Force active-looking status without requirements via direct SQL is forbidden;
      // instead assert pending cannot create sessions (already covered) and incomplete active path:
      const noPasskey = '30000000-0000-4000-8000-000000000016';
      await preparePendingPasskeyAccount(noPasskey);
      const actorId = '34000000-0000-4000-8000-000000000016';
      await createCivicActor(db(), {
        id: actorId,
        displayLabel: 'No passkey actor',
        communityId: FOUNDATION_COMMUNITY_IDS.milanoIt,
        createdAt: T2,
        updatedAt: T2,
      });
      await linkActorToAccount(db(), { actorId, accountId: noPasskey, at: T3 });
      await expect(
        transitionAccountState(db(), { accountId: noPasskey, to: 'active', at: T3 }),
      ).rejects.toBeInstanceOf(IdentityInvariantError);

      const noActor = '30000000-0000-4000-8000-000000000017';
      await preparePendingPasskeyAccount(noActor);
      await addPasskeyCredential(db(), {
        id: '33000000-0000-4000-8000-000000000017',
        accountId: noActor,
        credentialId: Buffer.from('cred-no-actor', 'utf8'),
        publicKey: Buffer.from('pub-no-actor', 'utf8'),
        signCount: 0,
        createdAt: T2,
      });
      await expect(
        transitionAccountState(db(), { accountId: noActor, to: 'active', at: T3 }),
      ).rejects.toMatchObject({ code: 'ACTIVE_REQUIRES_LINKED_ACTOR' });

      // Explicit repository checks once status is forced through incomplete paths:
      // create a fully active account then unlink actor is not allowed (unique link).
      // Cover no verified email by creating active then verifying requirement path via direct reject:
      const noVerifiedActive = '30000000-0000-4000-8000-000000000018';
      const prepared = await prepareActiveAccount(noVerifiedActive);
      await db().execute(
        sql`UPDATE town.account_emails SET verified_at = NULL WHERE id = ${prepared.emailId}`,
      );
      await expect(
        createAccountSession(db(), {
          id: '36000000-0000-4000-8000-000000000018',
          accountId: noVerifiedActive,
          tokenHash: deterministicSha256('session-no-verified'),
          clientType: 'web',
          createdAt: T3,
        }),
      ).rejects.toMatchObject({ code: 'SESSION_REQUIRES_VERIFIED_PRIMARY_EMAIL' });

      const noPasskeyActive = '30000000-0000-4000-8000-000000000019';
      const preparedPk = await prepareActiveAccount(noPasskeyActive);
      await db().execute(
        sql`UPDATE town.passkey_credentials SET revoked_at = ${T3} WHERE id = ${preparedPk.passkeyId}`,
      );
      await expect(
        createAccountSession(db(), {
          id: '36000000-0000-4000-8000-000000000019',
          accountId: noPasskeyActive,
          tokenHash: deterministicSha256('session-no-passkey'),
          clientType: 'mobile',
          createdAt: T3,
        }),
      ).rejects.toMatchObject({ code: 'SESSION_REQUIRES_ACTIVE_PASSKEY' });

      const noActorActive = '30000000-0000-4000-8000-00000000001a';
      const preparedActor = await prepareActiveAccount(noActorActive);
      await db()
        .update(actors)
        .set({ accountId: null })
        .where(eq(actors.id, preparedActor.actorId));
      await expect(
        createAccountSession(db(), {
          id: '36000000-0000-4000-8000-00000000001a',
          accountId: noActorActive,
          tokenHash: deterministicSha256('session-no-actor'),
          clientType: 'web',
          createdAt: T3,
        }),
      ).rejects.toMatchObject({ code: 'SESSION_REQUIRES_LINKED_ACTOR' });
    });

    it('does not accept setup or recovery grants as session authorization', async () => {
      const accountId = '30000000-0000-4000-8000-000000000020';
      await prepareActiveAccount(accountId);
      await preparePendingPasskeyAccount('30000000-0000-4000-8000-000000000021');
      const setupHash = deterministicSha256('setup-not-session');
      await createSetupGrant(db(), {
        id: '35000000-0000-4000-8000-000000000020',
        accountId: '30000000-0000-4000-8000-000000000021',
        tokenHash: setupHash,
        purpose: 'initial_passkey_registration',
        createdAt: T2,
        expiresAt: FUTURE,
      });
      await createRecoveryGrant(db(), {
        id: '35000000-0000-4000-8000-000000000021',
        accountId,
        tokenHash: deterministicSha256('recovery-not-session'),
        createdAt: T2,
        expiresAt: FUTURE,
      });

      await expect(
        findActiveAccountSessionByTokenHash(db(), { tokenHash: setupHash, now: T3 }),
      ).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });

      const recovery = await db().select().from(recoveryGrants);
      expect(recovery).toHaveLength(1);
      const recoveryTokenHash = recovery[0]?.tokenHash;
      expect(recoveryTokenHash).toBeInstanceOf(Buffer);
      await expect(
        findActiveAccountSessionByTokenHash(db(), {
          tokenHash: recoveryTokenHash ?? Buffer.alloc(0),
          now: T3,
        }),
      ).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
    });

    it('enforces idle/absolute expiry and activity extension rules', async () => {
      const accountId = '30000000-0000-4000-8000-000000000022';
      await prepareActiveAccount(accountId);
      const tokenHash = deterministicSha256('session-expiry');
      const created = await createAccountSession(db(), {
        id: '36000000-0000-4000-8000-000000000022',
        accountId,
        tokenHash,
        clientType: 'web',
        createdAt: T3,
      });

      const touchedAt = addMinutes(T3, 30);
      const touched = await touchAccountSession(db(), {
        sessionId: created.id,
        now: touchedAt,
      });
      assertAuthenticatedAtUnchangedByTouch(created, touched);
      expect(toIsoTimestamp(touched.absoluteExpiresAt)).toBe(
        toIsoTimestamp(created.absoluteExpiresAt),
      );
      expect(toIsoTimestamp(touched.idleExpiresAt)).toBe(
        computeIdleExpiresAt(touchedAt, toIsoTimestamp(created.absoluteExpiresAt)),
      );
      expect(toIsoTimestamp(touched.authenticatedAt)).toBe(toIsoTimestamp(created.authenticatedAt));

      await expect(
        findActiveAccountSessionByTokenHash(db(), {
          tokenHash,
          now: addMinutes(touched.idleExpiresAt, 1),
        }),
      ).rejects.toMatchObject({ code: 'SESSION_IDLE_EXPIRED' });

      const absoluteHash = deterministicSha256('session-absolute');
      const absoluteCreatedAt = '2026-07-15T12:00:00.000Z';
      await db()
        .insert(accountSessions)
        .values({
          id: '36000000-0000-4000-8000-000000000023',
          accountId,
          tokenHash: absoluteHash,
          clientType: 'web',
          createdAt: absoluteCreatedAt,
          authenticatedAt: absoluteCreatedAt,
          lastSeenAt: absoluteCreatedAt,
          idleExpiresAt: computeAbsoluteExpiresAt(absoluteCreatedAt),
          absoluteExpiresAt: computeAbsoluteExpiresAt(absoluteCreatedAt),
          revokedAt: null,
          revocationReason: null,
          recoveryRecentAt: null,
          securityVersion: 1,
        });
      await expect(
        findActiveAccountSessionByTokenHash(db(), { tokenHash: absoluteHash, now: T3 }),
      ).rejects.toMatchObject({ code: 'SESSION_ABSOLUTE_EXPIRED' });

      await revokeAccountSession(db(), {
        sessionId: created.id,
        reason: 'logout',
        now: touchedAt,
      });
      await expect(
        findActiveAccountSessionByTokenHash(db(), { tokenHash, now: touchedAt }),
      ).rejects.toMatchObject({ code: 'SESSION_REVOKED' });
      await expect(
        touchAccountSession(db(), { sessionId: created.id, now: touchedAt }),
      ).rejects.toMatchObject({ code: 'SESSION_REVOKED' });
    });

    it('rotates sessions atomically and supports revocation variants', async () => {
      const accountId = '30000000-0000-4000-8000-000000000024';
      await prepareActiveAccount(accountId);
      const oldHash = deterministicSha256('session-rotate-old');
      const newHash = deterministicSha256('session-rotate-new');
      const old = await createAccountSession(db(), {
        id: '36000000-0000-4000-8000-000000000024',
        accountId,
        tokenHash: oldHash,
        clientType: 'web',
        createdAt: T3,
        authenticatedAt: T3,
      });
      const other = await createAccountSession(db(), {
        id: '36000000-0000-4000-8000-000000000025',
        accountId,
        tokenHash: deterministicSha256('session-other'),
        clientType: 'mobile',
        createdAt: T3,
      });

      const rotated = await rotateAccountSession(db(), {
        oldSessionId: old.id,
        newSessionId: '36000000-0000-4000-8000-000000000026',
        newTokenHash: newHash,
        now: addMinutes(T3, 1),
        eventId: '37000000-0000-4000-8000-000000000026',
      });
      expect(rotated.previous.revocationReason).toBe('rotated');
      expect(rotated.replacement.tokenHash.equals(newHash)).toBe(true);
      expect(toIsoTimestamp(rotated.replacement.authenticatedAt)).toBe(
        toIsoTimestamp(old.authenticatedAt),
      );
      await expect(
        findActiveAccountSessionByTokenHash(db(), { tokenHash: oldHash, now: addMinutes(T3, 1) }),
      ).rejects.toMatchObject({ code: 'SESSION_REVOKED' });
      await expect(
        findActiveAccountSessionByTokenHash(db(), { tokenHash: newHash, now: addMinutes(T3, 1) }),
      ).resolves.toMatchObject({ id: rotated.replacement.id });

      const concurrent = await Promise.allSettled([
        rotateAccountSession(db(), {
          oldSessionId: rotated.replacement.id,
          newSessionId: '36000000-0000-4000-8000-000000000027',
          newTokenHash: deterministicSha256('session-rotate-a'),
          now: addMinutes(T3, 2),
        }),
        rotateAccountSession(db(), {
          oldSessionId: rotated.replacement.id,
          newSessionId: '36000000-0000-4000-8000-000000000028',
          newTokenHash: deterministicSha256('session-rotate-b'),
          now: addMinutes(T3, 2),
        }),
      ]);
      expect(concurrent.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(concurrent.filter((result) => result.status === 'rejected')).toHaveLength(1);

      const keep = await createAccountSession(db(), {
        id: '36000000-0000-4000-8000-000000000029',
        accountId,
        tokenHash: deterministicSha256('session-keep'),
        clientType: 'web',
        createdAt: addMinutes(T3, 3),
      });
      await revokeAllOtherAccountSessions(db(), {
        accountId,
        keepSessionId: keep.id,
        reason: 'logout_all',
        now: addMinutes(T3, 4),
      });
      const active = await listActiveAccountSessionsForAccount(db(), {
        accountId,
        now: addMinutes(T3, 4),
      });
      expect(active.map((row) => row.id)).toEqual([keep.id]);

      await revokeAllAccountSessions(db(), {
        accountId,
        reason: 'account_suspended',
        now: addMinutes(T3, 5),
        eventId: '37000000-0000-4000-8000-000000000029',
      });
      expect(
        await listActiveAccountSessionsForAccount(db(), {
          accountId,
          now: addMinutes(T3, 5),
        }),
      ).toEqual([]);

      const again = await revokeAccountSession(db(), {
        sessionId: keep.id,
        reason: 'logout',
        now: addMinutes(T3, 6),
      });
      expect(again.revocationReason).toBe('account_suspended');
      expect(other.id).toBeTruthy();
    });

    it('evaluates sensitive freshness without refreshing authenticated_at on touch/rotate', async () => {
      const accountId = '30000000-0000-4000-8000-000000000030';
      await prepareActiveAccount(accountId);
      const authenticatedAt = T3;
      const session = await createAccountSession(db(), {
        id: '36000000-0000-4000-8000-000000000030',
        accountId,
        tokenHash: deterministicSha256('session-fresh'),
        clientType: 'web',
        createdAt: authenticatedAt,
        authenticatedAt,
        recoveryRecentAt: addMinutes(authenticatedAt, 20),
      });

      expect(sessionSupportsSensitiveOperation(session, addMinutes(authenticatedAt, 10))).toBe(
        true,
      );
      expect(sessionSupportsSensitiveOperation(session, addMinutes(authenticatedAt, 11))).toBe(
        false,
      );
      expect(session.recoveryRecentAt).not.toBe(session.authenticatedAt);

      const touched = await touchAccountSession(db(), {
        sessionId: session.id,
        now: addMinutes(authenticatedAt, 5),
      });
      expect(toIsoTimestamp(touched.authenticatedAt)).toBe(authenticatedAt);

      const rotated = await rotateAccountSession(db(), {
        oldSessionId: session.id,
        newSessionId: '36000000-0000-4000-8000-000000000031',
        newTokenHash: deterministicSha256('session-fresh-rotated'),
        now: addMinutes(authenticatedAt, 6),
      });
      expect(toIsoTimestamp(rotated.replacement.authenticatedAt)).toBe(authenticatedAt);
      expect(
        sessionSupportsSensitiveOperation(rotated.replacement, addMinutes(authenticatedAt, 11)),
      ).toBe(false);
    });
  });

  describe('ceremony rate limits', () => {
    it('supports atomic increments, uniqueness, blocking, and hashed subjects only', async () => {
      const subjectHash = deterministicSha256('rate-subject');
      const bucket = await getOrCreateCeremonyRateLimitBucket(db(), {
        id: '38000000-0000-4000-8000-000000000001',
        scope: 'email_verification_request_email',
        subjectHash,
        windowStartedAt: T0,
        windowExpiresAt: addMinutes(T0, 60),
        createdAt: T0,
      });
      const same = await getOrCreateCeremonyRateLimitBucket(db(), {
        id: '38000000-0000-4000-8000-000000000099',
        scope: 'email_verification_request_email',
        subjectHash,
        windowStartedAt: T0,
        windowExpiresAt: addMinutes(T0, 60),
        createdAt: T0,
      });
      expect(same.id).toBe(bucket.id);

      await Promise.all(
        Array.from({ length: 10 }, () =>
          incrementCeremonyRateLimit(db(), { id: bucket.id, now: T1 }),
        ),
      );
      expect(await getCeremonyRateLimitCount(db(), bucket.id)).toBe(10);

      await setCeremonyRateLimitBlockedUntil(db(), {
        id: bucket.id,
        blockedUntil: T3,
        now: T1,
      });
      expect(await isCeremonyRateLimitBlocked(db(), { id: bucket.id, now: T2 })).toBe(true);
      expect(await isCeremonyRateLimitBlocked(db(), { id: bucket.id, now: FUTURE })).toBe(false);

      await resetCeremonyRateLimitForTests(db(), { id: bucket.id, now: T3 });
      expect(await getCeremonyRateLimitCount(db(), bucket.id)).toBe(0);
      expect(await isCeremonyRateLimitBlocked(db(), { id: bucket.id, now: T3 })).toBe(false);

      await expect(
        getOrCreateCeremonyRateLimitBucket(db(), {
          id: '38000000-0000-4000-8000-000000000002',
          scope: 'not_a_real_scope' as never,
          subjectHash,
          windowStartedAt: T0,
          windowExpiresAt: addMinutes(T0, 60),
          createdAt: T0,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_RATE_LIMIT_SCOPE' });

      await expect(
        db().execute(sql`
            INSERT INTO town.ceremony_rate_limits (
              id, scope, subject_hash, window_started_at, window_expires_at,
              attempt_count, blocked_until, created_at, updated_at
            ) VALUES (
              '38000000-0000-4000-8000-000000000003',
              'email_verification_request_ip',
              ${subjectHash},
              ${T1},
              ${addMinutes(T1, 60)},
              -1,
              NULL,
              ${T1},
              ${T1}
            )
          `),
      ).rejects.toThrow();

      const columns = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'town' AND table_name = 'ceremony_rate_limits'`,
      );
      const names = columns.rows.map((row) => row.column_name);
      expect(names).not.toEqual(expect.arrayContaining(['email', 'ip', 'credential_id']));
      expect(names).toContain('subject_hash');
    });
  });

  describe('security events', () => {
    it('accepts previous and new event types and rejects unknown/sensitive metadata', async () => {
      const accountId = '30000000-0000-4000-8000-000000000040';
      await prepareActiveAccount(accountId);

      const previousTypes = [
        'email_verification_requested',
        'email_verified',
        'passkey_registered',
        'passkey_used',
        'passkey_revoked',
        'recovery_requested',
        'recovery_completed',
        'account_suspended',
        'account_closed',
      ] as const;
      const newTypes = [
        'authentication_failed',
        'session_created',
        'session_rotated',
        'session_revoked',
        'counter_anomaly_detected',
        'rate_limit_triggered',
      ] as const;

      let index = 0;
      for (const eventType of [...previousTypes, ...newTypes]) {
        index += 1;
        await appendIdentitySecurityEvent(db(), {
          id: `39000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
          accountId,
          eventType,
          occurredAt: T3,
          metadata: { note: eventType },
        });
      }

      const events = await listIdentitySecurityEventsForAccount(db(), accountId);
      expect(events).toHaveLength(previousTypes.length + newTypes.length);

      await expect(
        appendIdentitySecurityEvent(db(), {
          id: '39000000-0000-4000-8000-000000000099',
          accountId,
          eventType: 'not_real' as never,
          occurredAt: T3,
        }),
      ).rejects.toMatchObject({ code: 'UNKNOWN_SECURITY_EVENT_TYPE' });

      await expect(
        appendIdentitySecurityEvent(db(), {
          id: '39000000-0000-4000-8000-000000000098',
          accountId,
          eventType: 'session_created',
          occurredAt: T3,
          metadata: { token: 'raw-session-token' },
        }),
      ).rejects.toThrow(/forbidden field/i);

      expect(
        (
          await db()
            .select({ value: count() })
            .from(identitySecurityEvents)
            .where(
              and(
                eq(identitySecurityEvents.accountId, accountId),
                isNull(identitySecurityEvents.requestId),
              ),
            )
        )[0]?.value,
      ).toBeGreaterThan(0);
    });
  });
});

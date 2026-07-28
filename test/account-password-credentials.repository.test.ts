import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createDatabase, type Database } from '../src/db/client.js';
import { IdentityInvariantError } from '../src/identity/errors.js';
import { hashPassword } from '../src/identity/password-hashing.js';
import { createAccountShell } from '../src/identity/repositories/accounts.js';
import {
  createAccountPasswordCredential,
  findActiveAccountPasswordCredential,
  findAccountPasswordCredentialById,
  revokeAccountPasswordCredential,
} from '../src/identity/repositories/password-credentials.js';
import { toIsoTimestamp } from '../src/lib/timestamps.js';
import { requireDatabaseUrl, resetMigrateSeedFoundationAndActor } from './helpers/pg.js';

const T0 = '2026-07-16T12:00:00.000Z';
const T1 = '2026-07-16T12:05:00.000Z';
const T2 = '2026-07-16T12:10:00.000Z';

describe('account password credential repository', () => {
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

  async function prepareAccount(): Promise<string> {
    if (!database) {
      throw new Error('database not initialized');
    }
    const accountId = randomUUID();
    await createAccountShell(database.db, {
      id: accountId,
      createdAt: T0,
      updatedAt: T0,
    });
    return accountId;
  }

  it('creates, fetches, and revokes an active password credential', async () => {
    if (!database) {
      throw new Error('database not initialized');
    }
    const accountId = await prepareAccount();
    const hashed = await hashPassword('repo-test-password-value');
    const credentialId = randomUUID();

    const created = await createAccountPasswordCredential(database.db, {
      id: credentialId,
      accountId,
      passwordHash: hashed.hash,
      algorithm: hashed.algorithm,
      parameters: hashed.parameters,
      createdAt: T0,
    });

    expect(created.id).toBe(credentialId);
    expect(created.accountId).toBe(accountId);
    expect(created.passwordHash).toBe(hashed.hash);
    expect(created.algorithm).toBe('argon2id');
    expect(created.revokedAt).toBeNull();
    expect(toIsoTimestamp(created.createdAt)).toBe(T0);
    expect(toIsoTimestamp(created.updatedAt)).toBe(T0);

    const active = await findActiveAccountPasswordCredential(database.db, accountId);
    expect(active?.id).toBe(credentialId);

    const byId = await findAccountPasswordCredentialById(database.db, credentialId);
    expect(byId?.passwordHash).toBe(hashed.hash);

    const revoked = await revokeAccountPasswordCredential(database.db, {
      accountId,
      revokedAt: T1,
    });
    expect(revoked.revokedAt ? toIsoTimestamp(revoked.revokedAt) : null).toBe(T1);
    expect(toIsoTimestamp(revoked.updatedAt)).toBe(T1);

    await expect(findActiveAccountPasswordCredential(database.db, accountId)).resolves.toBeNull();

    const stillPresent = await findAccountPasswordCredentialById(database.db, credentialId);
    expect(stillPresent?.revokedAt ? toIsoTimestamp(stillPresent.revokedAt) : null).toBe(T1);
  });

  it('enforces at most one active password credential per account', async () => {
    if (!database) {
      throw new Error('database not initialized');
    }
    const accountId = await prepareAccount();
    const first = await hashPassword('first-password-value');
    const second = await hashPassword('second-password-value');

    await createAccountPasswordCredential(database.db, {
      id: randomUUID(),
      accountId,
      passwordHash: first.hash,
      parameters: first.parameters,
      createdAt: T0,
    });

    await expect(
      createAccountPasswordCredential(database.db, {
        id: randomUUID(),
        accountId,
        passwordHash: second.hash,
        parameters: second.parameters,
        createdAt: T1,
      }),
    ).rejects.toMatchObject({
      name: 'IdentityInvariantError',
      code: 'DUPLICATE_ACTIVE_PASSWORD_CREDENTIAL',
    } satisfies Partial<IdentityInvariantError>);
  });

  it('allows a new credential after the previous one is revoked', async () => {
    if (!database) {
      throw new Error('database not initialized');
    }
    const accountId = await prepareAccount();
    const first = await hashPassword('first-password-value');
    const second = await hashPassword('second-password-value');

    await createAccountPasswordCredential(database.db, {
      id: randomUUID(),
      accountId,
      passwordHash: first.hash,
      parameters: first.parameters,
      createdAt: T0,
    });
    await revokeAccountPasswordCredential(database.db, { accountId, revokedAt: T1 });

    const replacement = await createAccountPasswordCredential(database.db, {
      id: randomUUID(),
      accountId,
      passwordHash: second.hash,
      parameters: second.parameters,
      createdAt: T2,
    });
    expect(replacement.revokedAt).toBeNull();
    expect(replacement.passwordHash).toBe(second.hash);

    const active = await findActiveAccountPasswordCredential(database.db, accountId);
    expect(active?.id).toBe(replacement.id);
  });

  it('rejects revoke when no active credential exists', async () => {
    if (!database) {
      throw new Error('database not initialized');
    }
    const accountId = await prepareAccount();
    await expect(
      revokeAccountPasswordCredential(database.db, { accountId, revokedAt: T1 }),
    ).rejects.toMatchObject({
      name: 'IdentityInvariantError',
      code: 'PASSWORD_CREDENTIAL_NOT_ACTIVE',
    });
  });
});

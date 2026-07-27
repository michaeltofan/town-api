import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { createDatabase } from '../src/db/client.js';
import { membershipEntitlements } from '../src/db/schema.js';
import { createAccountShell } from '../src/identity/repositories/accounts.js';
import {
  StagingGrantMembershipError,
  parseAccountIdArg,
  runStagingGrantMembership,
} from '../src/membership/run-staging-grant-membership.js';
import { requireDatabaseUrl, resetAndMigrate } from './helpers/pg.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const accountId = '11000000-0000-4000-8000-000000000501';
const t0 = new Date('2026-07-17T12:00:00.000Z');
const expectedAccessUntil = '2027-07-17T12:00:00.000Z';

function iso(value: string | null | undefined): string {
  if (value == null) {
    throw new Error('expected timestamp');
  }
  return new Date(value).toISOString();
}

function createSequentialIdGenerator(prefixByte: string): () => string {
  let n = 0;
  return () => {
    n += 1;
    const suffix = n.toString(16).padStart(12, '0');
    return `${prefixByte}000000-0000-4000-8000-${suffix}`;
  };
}

describe('staging grant membership environment gate', () => {
  it('refuses when NODE_ENV is production', async () => {
    await expect(
      runStagingGrantMembership({
        accountId,
        env: {
          NODE_ENV: 'production',
          APP_ENV: 'staging',
          DATABASE_URL: 'postgres://town:town@127.0.0.1:5432/town',
        },
      }),
    ).rejects.toMatchObject({
      code: 'NODE_ENV_PRODUCTION',
    } satisfies Partial<StagingGrantMembershipError>);
  });

  it('refuses when APP_ENV is not staging', async () => {
    await expect(
      runStagingGrantMembership({
        accountId,
        env: {
          NODE_ENV: 'development',
          APP_ENV: 'production',
          DATABASE_URL: 'postgres://town:town@127.0.0.1:5432/town',
        },
      }),
    ).rejects.toMatchObject({ code: 'APP_ENV_NOT_STAGING' });
  });

  it('parses --account-id', () => {
    expect(parseAccountIdArg(['--account-id', accountId])).toBe(accountId);
    expect(parseAccountIdArg([`--account-id=${accountId}`])).toBe(accountId);
  });
});

describe('staging grant membership entrypoint wiring', () => {
  it('declares local and compiled production one-off scripts', () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['membership:grant:staging']).toBe('tsx scripts/grant-staging-membership.ts');
    expect(pkg.scripts['membership:grant:staging:production']).toBe(
      'node dist/scripts/grant-staging-membership.js',
    );
  });
});

describe('staging grant membership integration', () => {
  const databaseUrl = requireDatabaseUrl();
  let pool: Pool;

  const stagingEnv = {
    NODE_ENV: 'development',
    APP_ENV: 'staging',
    DATABASE_URL: databaseUrl,
  };

  beforeAll(() => {
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
  });

  beforeEach(async () => {
    await resetAndMigrate(pool);
    const database = createDatabase({
      connectionString: databaseUrl,
      poolMax: 2,
      connectionTimeoutMs: 3_000,
      idleTimeoutMs: 1_000,
    });
    try {
      await createAccountShell(database.db, {
        id: accountId,
        createdAt: t0.toISOString(),
        updatedAt: t0.toISOString(),
      });
    } finally {
      await database.close();
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  it('grants an existing account an active membership via activateMembership', async () => {
    const result = await runStagingGrantMembership({
      accountId,
      env: stagingEnv,
      now: () => t0,
      generateId: createSequentialIdGenerator('a1'),
    });

    expect(result.outcome).toBe('granted');
    expect(result.accountId).toBe(accountId);
    expect(result.membershipStatus).toBe('active');
    expect(iso(result.accessUntil)).toBe(expectedAccessUntil);
    expect(result.transitionResult).toBe('applied');

    const database = createDatabase({
      connectionString: databaseUrl,
      poolMax: 2,
      connectionTimeoutMs: 3_000,
      idleTimeoutMs: 1_000,
    });
    try {
      const rows = await database.db
        .select()
        .from(membershipEntitlements)
        .where(eq(membershipEntitlements.accountId, accountId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe('active');
      expect(rows[0]?.source).toBe('test_fixture');
      expect(iso(rows[0]?.accessUntil)).toBe(expectedAccessUntil);
    } finally {
      await database.close();
    }
  });

  it('is idempotent-safe: already-active account no-ops without corrupting state', async () => {
    const first = await runStagingGrantMembership({
      accountId,
      env: stagingEnv,
      now: () => t0,
      generateId: createSequentialIdGenerator('b2'),
    });
    expect(first.outcome).toBe('granted');
    const grantedUntil = first.accessUntil;
    expect(grantedUntil).toBeTruthy();

    const database = createDatabase({
      connectionString: databaseUrl,
      poolMax: 2,
      connectionTimeoutMs: 3_000,
      idleTimeoutMs: 1_000,
    });
    let versionAfterGrant: number;
    try {
      const rows = await database.db
        .select()
        .from(membershipEntitlements)
        .where(eq(membershipEntitlements.accountId, accountId));
      versionAfterGrant = Number(rows[0]?.version);
    } finally {
      await database.close();
    }

    const second = await runStagingGrantMembership({
      accountId,
      env: stagingEnv,
      now: () => new Date(t0.getTime() + 60_000),
      generateId: createSequentialIdGenerator('c3'),
    });

    expect(second.outcome).toBe('already_active');
    expect(second.accountId).toBe(accountId);
    expect(second.membershipStatus).toBe('active');
    expect(iso(second.accessUntil)).toBe(iso(grantedUntil));
    expect(second.transitionResult).toBeUndefined();

    const databaseAfter = createDatabase({
      connectionString: databaseUrl,
      poolMax: 2,
      connectionTimeoutMs: 3_000,
      idleTimeoutMs: 1_000,
    });
    try {
      const rows = await databaseAfter.db
        .select()
        .from(membershipEntitlements)
        .where(eq(membershipEntitlements.accountId, accountId));
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]?.version)).toBe(versionAfterGrant);
      expect(iso(rows[0]?.accessUntil)).toBe(iso(grantedUntil));
      expect(rows[0]?.status).toBe('active');
    } finally {
      await databaseAfter.close();
    }
  });
});

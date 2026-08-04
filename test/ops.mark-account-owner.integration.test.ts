import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { createDatabase } from '../src/db/client.js';
import { EXPECTED_MIGRATION_COUNT } from '../src/db/migration-ledger.js';
import { accounts } from '../src/db/schema.js';
import { createAccountShell } from '../src/identity/repositories/accounts.js';
import {
  MarkAccountOwnerError,
  OWNER_SETUP_CODE_LENGTH,
  parseAccountIdArg,
  runMarkAccountOwner,
} from '../src/identity/run-mark-account-owner.js';
import { requireDatabaseUrl, resetAndMigrate } from './helpers/pg.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const accountId = '11000000-0000-4000-8000-000000000601';
const t0 = new Date('2026-07-17T12:00:00.000Z');

/** Deterministic 128-char fixture codes (not production secrets). */
const VALID_CODE = 'a'.repeat(OWNER_SETUP_CODE_LENGTH);
const OTHER_CODE = 'b'.repeat(OWNER_SETUP_CODE_LENGTH);

describe('mark account owner setup-code gate', () => {
  it('refuses when OWNER_SETUP_CODE is missing (no DB change attempted)', async () => {
    await expect(
      runMarkAccountOwner({
        accountId,
        env: {
          DATABASE_URL: 'postgres://town:town@127.0.0.1:5432/town',
          OWNER_SETUP_CODE_EXPECTED: VALID_CODE,
        },
      }),
    ).rejects.toMatchObject({
      code: 'OWNER_SETUP_CODE_REQUIRED',
    } satisfies Partial<MarkAccountOwnerError>);
  });

  it('refuses when OWNER_SETUP_CODE_EXPECTED is missing', async () => {
    await expect(
      runMarkAccountOwner({
        accountId,
        env: {
          DATABASE_URL: 'postgres://town:town@127.0.0.1:5432/town',
          OWNER_SETUP_CODE: VALID_CODE,
        },
      }),
    ).rejects.toMatchObject({ code: 'OWNER_SETUP_CODE_EXPECTED_REQUIRED' });
  });

  it('refuses when codes differ (constant-time mismatch)', async () => {
    await expect(
      runMarkAccountOwner({
        accountId,
        env: {
          DATABASE_URL: 'postgres://town:town@127.0.0.1:5432/town',
          OWNER_SETUP_CODE: VALID_CODE,
          OWNER_SETUP_CODE_EXPECTED: OTHER_CODE,
        },
      }),
    ).rejects.toMatchObject({ code: 'OWNER_SETUP_CODE_MISMATCH' });
  });

  it('refuses wrong-length code', async () => {
    await expect(
      runMarkAccountOwner({
        accountId,
        env: {
          DATABASE_URL: 'postgres://town:town@127.0.0.1:5432/town',
          OWNER_SETUP_CODE: 'short',
          OWNER_SETUP_CODE_EXPECTED: VALID_CODE,
        },
      }),
    ).rejects.toMatchObject({ code: 'OWNER_SETUP_CODE_INVALID_LENGTH' });
  });

  it('parses --account-id', () => {
    expect(parseAccountIdArg(['--account-id', accountId])).toBe(accountId);
    expect(parseAccountIdArg([`--account-id=${accountId}`])).toBe(accountId);
  });
});

describe('mark account owner entrypoint wiring', () => {
  it('declares local and compiled production one-off scripts', () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['account:mark-owner']).toBe('tsx scripts/mark-account-owner.ts');
    expect(pkg.scripts['account:mark-owner:production']).toBe(
      'node dist/scripts/mark-account-owner.js',
    );
  });

  it('migration count includes accounts is_owner migration', () => {
    expect(EXPECTED_MIGRATION_COUNT).toBe(47);
  });

  it('is_owner is consulted by civic-access and owner moderation; membership exposes self-only isOwner', () => {
    const civicAccess = readFileSync(path.join(root, 'src/membership/civic-access.ts'), 'utf8');
    const membershipRoutes = readFileSync(path.join(root, 'src/routes/membership.ts'), 'utf8');
    const membershipRead = readFileSync(path.join(root, 'src/membership/read-service.ts'), 'utf8');
    const confirmationRoutes = readFileSync(path.join(root, 'src/routes/confirmations.ts'), 'utf8');
    const signalModerationRoutes = readFileSync(
      path.join(root, 'src/routes/signal-moderation.ts'),
      'utf8',
    );
    const accountModerationRoutes = readFileSync(
      path.join(root, 'src/routes/account-moderation.ts'),
      'utf8',
    );
    const app = readFileSync(path.join(root, 'src/app.ts'), 'utf8');

    // Owner participation slice: civic-access branches on isOwner for membership bypass.
    expect(civicAccess).toMatch(/isOwner/);
    // Membership self-read exposes isOwner for owner-tool UI gating; never from request body.
    expect(membershipRead).toMatch(/isOwner: account\?\.isOwner === true/);
    expect(membershipRoutes).toMatch(/isOwner/);
    expect(membershipRoutes).not.toMatch(/body\.isOwner|request\.body.*isOwner/);
    // Confirmations route passes already-loaded isOwner through to evaluateCivicAccess.
    expect(confirmationRoutes).toMatch(/isOwner/);
    // Owner hide/unhide and ban/unban gate on the locked account row's isOwner.
    expect(signalModerationRoutes).toMatch(/isOwner/);
    expect(accountModerationRoutes).toMatch(/isOwner/);
    // app.ts may redact OWNER_SETUP_CODE* names; it must not branch on is_owner.
    expect(app).not.toMatch(/is_owner|isOwner/);
  });
});

describe('mark account owner integration', () => {
  const databaseUrl = requireDatabaseUrl();
  let pool: Pool;

  const ownerEnv = {
    DATABASE_URL: databaseUrl,
    OWNER_SETUP_CODE: VALID_CODE,
    OWNER_SETUP_CODE_EXPECTED: VALID_CODE,
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

  it('defaults is_owner to false for new accounts', async () => {
    const database = createDatabase({
      connectionString: databaseUrl,
      poolMax: 2,
      connectionTimeoutMs: 3_000,
      idleTimeoutMs: 1_000,
    });
    try {
      const rows = await database.db.select().from(accounts).where(eq(accounts.id, accountId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.isOwner).toBe(false);
    } finally {
      await database.close();
    }
  });

  it('marks an account owner when the 128-char setup code matches', async () => {
    const result = await runMarkAccountOwner({
      accountId,
      env: ownerEnv,
      now: () => t0,
    });

    expect(result.outcome).toBe('marked');
    expect(result.accountId).toBe(accountId);
    expect(result.isOwner).toBe(true);

    const database = createDatabase({
      connectionString: databaseUrl,
      poolMax: 2,
      connectionTimeoutMs: 3_000,
      idleTimeoutMs: 1_000,
    });
    try {
      const rows = await database.db.select().from(accounts).where(eq(accounts.id, accountId));
      expect(rows[0]?.isOwner).toBe(true);
    } finally {
      await database.close();
    }
  });

  it('refuses a wrong code and leaves is_owner false', async () => {
    await expect(
      runMarkAccountOwner({
        accountId,
        env: {
          DATABASE_URL: databaseUrl,
          OWNER_SETUP_CODE: OTHER_CODE,
          OWNER_SETUP_CODE_EXPECTED: VALID_CODE,
        },
      }),
    ).rejects.toMatchObject({ code: 'OWNER_SETUP_CODE_MISMATCH' });

    const database = createDatabase({
      connectionString: databaseUrl,
      poolMax: 2,
      connectionTimeoutMs: 3_000,
      idleTimeoutMs: 1_000,
    });
    try {
      const rows = await database.db.select().from(accounts).where(eq(accounts.id, accountId));
      expect(rows[0]?.isOwner).toBe(false);
    } finally {
      await database.close();
    }
  });

  it('is idempotent: already-owner account no-ops safely', async () => {
    const first = await runMarkAccountOwner({
      accountId,
      env: ownerEnv,
      now: () => t0,
    });
    expect(first.outcome).toBe('marked');

    const second = await runMarkAccountOwner({
      accountId,
      env: ownerEnv,
      now: () => new Date(t0.getTime() + 60_000),
    });
    expect(second.outcome).toBe('already_owner');
    expect(second.accountId).toBe(accountId);
    expect(second.isOwner).toBe(true);

    const database = createDatabase({
      connectionString: databaseUrl,
      poolMax: 2,
      connectionTimeoutMs: 3_000,
      idleTimeoutMs: 1_000,
    });
    try {
      const rows = await database.db.select().from(accounts).where(eq(accounts.id, accountId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.isOwner).toBe(true);
    } finally {
      await database.close();
    }
  });
});

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { EXPECTED_MIGRATION_COUNT } from '../src/db/migration-ledger.js';
import { migrationsFolder, requireDatabaseUrl } from './helpers/pg.js';

type Journal = {
  version: string;
  dialect: string;
  entries: {
    idx: number;
    version: string;
    when: number;
    tag: string;
    breakpoints: boolean;
  }[];
};

async function migrateThroughTag(pool: Pool, throughTag: string): Promise<string> {
  const journalPath = path.join(migrationsFolder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as Journal;
  const throughIndex = journal.entries.findIndex((entry) => entry.tag === throughTag);
  if (throughIndex < 0) {
    throw new Error(`Migration tag not found: ${throughTag}`);
  }

  const tempRoot = mkdtempSync(path.join(tmpdir(), 'town-migrate-through-'));
  const tempMeta = path.join(tempRoot, 'meta');
  mkdirSync(tempMeta, { recursive: true });

  const truncated: Journal = {
    version: journal.version,
    dialect: journal.dialect,
    entries: journal.entries.slice(0, throughIndex + 1).map((entry, index) => ({
      ...entry,
      idx: index,
    })),
  };
  writeFileSync(path.join(tempMeta, '_journal.json'), `${JSON.stringify(truncated, null, 2)}\n`);

  for (const entry of truncated.entries) {
    copyFileSync(
      path.join(migrationsFolder, `${entry.tag}.sql`),
      path.join(tempRoot, `${entry.tag}.sql`),
    );
  }

  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
  await pool.query('DROP SCHEMA IF EXISTS town CASCADE');
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder: tempRoot });
  return tempRoot;
}

describe('password sign-in migration 0027', () => {
  const databaseUrl = requireDatabaseUrl();
  let pool: Pool;
  let tempMigrationFolder: string | undefined;

  beforeAll(() => {
    pool = new Pool({ connectionString: databaseUrl, max: 1 });
  });

  afterAll(async () => {
    if (tempMigrationFolder !== undefined) {
      rmSync(tempMigrationFolder, { recursive: true, force: true });
    }
    await pool.end();
  });

  it('extends ceremony_rate_limits scope vocabulary without new tables', async () => {
    await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS town CASCADE');
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder });

    const check = await pool.query<{ consrc: string }>(
      `SELECT pg_get_constraintdef(oid) AS consrc
       FROM pg_constraint
       WHERE conname = 'ceremony_rate_limits_scope_valid'`,
    );
    const definition = check.rows[0]?.consrc ?? '';
    expect(definition).toContain('password_sign_in_ip');
    expect(definition).toContain('password_sign_in_email');
    expect(definition).toContain('password_setup_grant');
    expect(definition).toContain('passkey_assertion_ip');

    const tables = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'town' AND table_name = 'password_sign_in_attempts'
       ) AS exists`,
    );
    expect(tables.rows[0]?.exists).toBe(false);
  });

  it('upgrades in place from real post-0026 schema while preserving existing rate-limit rows', async () => {
    tempMigrationFolder = await migrateThroughTag(pool, '0026_initial_password_setup_ceremony');

    const beforeCount = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM drizzle.__drizzle_migrations`,
    );
    expect(Number(beforeCount.rows[0]?.count ?? 0)).toBe(27);

    const beforeConstraint = await pool.query<{ consrc: string }>(
      `SELECT pg_get_constraintdef(oid) AS consrc
       FROM pg_constraint
       WHERE conname = 'ceremony_rate_limits_scope_valid'`,
    );
    const beforeDefinition = beforeConstraint.rows[0]?.consrc ?? '';
    expect(beforeDefinition).toContain('password_setup_grant');
    expect(beforeDefinition).not.toContain('password_sign_in_ip');
    expect(beforeDefinition).not.toContain('password_sign_in_email');

    const existingRowId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const existingSubjectHash = Buffer.from(
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      'hex',
    );
    const existingWindowStartedAt = '2026-07-01T00:00:00.000Z';
    const existingWindowExpiresAt = '2026-07-01T00:30:00.000Z';
    const existingCreatedAt = '2026-07-01T00:01:00.000Z';
    const existingUpdatedAt = '2026-07-01T00:02:00.000Z';
    const existingAttemptCount = 4;

    await pool.query(
      `INSERT INTO town.ceremony_rate_limits (
         id, scope, subject_hash, window_started_at, window_expires_at,
         attempt_count, blocked_until, created_at, updated_at
       ) VALUES (
         $1, 'password_setup_grant', $2, $3::timestamptz, $4::timestamptz,
         $5, NULL, $6::timestamptz, $7::timestamptz
       )`,
      [
        existingRowId,
        existingSubjectHash,
        existingWindowStartedAt,
        existingWindowExpiresAt,
        existingAttemptCount,
        existingCreatedAt,
        existingUpdatedAt,
      ],
    );

    const db = drizzle(pool);
    await migrate(db, { migrationsFolder });

    const afterCount = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM drizzle.__drizzle_migrations`,
    );
    expect(Number(afterCount.rows[0]?.count ?? 0)).toBe(EXPECTED_MIGRATION_COUNT);
    expect(EXPECTED_MIGRATION_COUNT).toBe(36);

    const ordered = await pool.query<{ id: number; created_at: string }>(
      `SELECT id, created_at::text AS created_at
       FROM drizzle.__drizzle_migrations
       ORDER BY id ASC`,
    );
    expect(ordered.rows).toHaveLength(36);
    for (let index = 0; index < ordered.rows.length; index += 1) {
      expect(ordered.rows[index]?.id).toBe(index + 1);
    }

    const preserved = await pool.query<{
      id: string;
      scope: string;
      subject_hash: Buffer;
      window_started_at: Date;
      window_expires_at: Date;
      attempt_count: number;
      blocked_until: Date | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, scope, subject_hash, window_started_at, window_expires_at,
              attempt_count, blocked_until, created_at, updated_at
       FROM town.ceremony_rate_limits
       WHERE id = $1`,
      [existingRowId],
    );
    expect(preserved.rows).toHaveLength(1);
    const row = preserved.rows[0];
    if (row === undefined) {
      throw new Error('expected preserved ceremony_rate_limits row');
    }
    expect(row.scope).toBe('password_setup_grant');
    expect(Buffer.compare(row.subject_hash, existingSubjectHash)).toBe(0);
    expect(row.attempt_count).toBe(existingAttemptCount);
    expect(row.blocked_until).toBeNull();
    expect(new Date(row.window_started_at).toISOString()).toBe(existingWindowStartedAt);
    expect(new Date(row.window_expires_at).toISOString()).toBe(existingWindowExpiresAt);
    expect(new Date(row.created_at).toISOString()).toBe(existingCreatedAt);
    expect(new Date(row.updated_at).toISOString()).toBe(existingUpdatedAt);

    const afterConstraint = await pool.query<{ consrc: string }>(
      `SELECT pg_get_constraintdef(oid) AS consrc
       FROM pg_constraint
       WHERE conname = 'ceremony_rate_limits_scope_valid'`,
    );
    const afterDefinition = afterConstraint.rows[0]?.consrc ?? '';
    for (const scope of [
      'email_verification_request_email',
      'passkey_assertion_ip',
      'billing_portal_account',
      'password_setup_grant',
      'password_sign_in_ip',
      'password_sign_in_email',
    ]) {
      expect(afterDefinition).toContain(scope);
    }

    const acceptScopes = [
      'password_setup_grant',
      'passkey_assertion_ip',
      'email_verification_request_ip',
      'password_sign_in_ip',
      'password_sign_in_email',
    ] as const;
    for (const [index, scope] of acceptScopes.entries()) {
      await expect(
        pool.query(
          `INSERT INTO town.ceremony_rate_limits (
             id, scope, subject_hash, window_started_at, window_expires_at,
             attempt_count, blocked_until, created_at, updated_at
           ) VALUES (
             $1, $2, $3, '2026-07-02T00:00:00.000Z'::timestamptz,
             '2026-07-02T00:30:00.000Z'::timestamptz, 1, NULL,
             '2026-07-02T00:00:00.000Z'::timestamptz, '2026-07-02T00:00:00.000Z'::timestamptz
           )`,
          [
            `bbbbbbbb-bbbb-4bbb-8bbb-${String(index).padStart(12, '0')}`,
            scope,
            Buffer.alloc(32, index + 1),
          ],
        ),
      ).resolves.toBeTruthy();
    }

    await expect(
      pool.query(
        `INSERT INTO town.ceremony_rate_limits (
           id, scope, subject_hash, window_started_at, window_expires_at,
           attempt_count, blocked_until, created_at, updated_at
         ) VALUES (
           'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'not_a_real_scope', $1,
           '2026-07-02T00:00:00.000Z'::timestamptz, '2026-07-02T00:30:00.000Z'::timestamptz,
           1, NULL, '2026-07-02T00:00:00.000Z'::timestamptz, '2026-07-02T00:00:00.000Z'::timestamptz
         )`,
        [Buffer.alloc(32, 9)],
      ),
    ).rejects.toThrow();
  });
});

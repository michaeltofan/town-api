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

function readMigrationSql(tag: string): string {
  return readFileSync(path.join(migrationsFolder, `${tag}.sql`), 'utf8');
}

describe('password change migration 0028', () => {
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

  it('extends rate-limit, security-event, and revocation vocabularies without new tables', async () => {
    await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS town CASCADE');
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder });

    const scopeCheck = await pool.query<{ consrc: string }>(
      `SELECT pg_get_constraintdef(oid) AS consrc
       FROM pg_constraint
       WHERE conname = 'ceremony_rate_limits_scope_valid'`,
    );
    const scopeDefinition = scopeCheck.rows[0]?.consrc ?? '';
    expect(scopeDefinition).toContain('password_change_account');
    expect(scopeDefinition).toContain('password_sign_in_ip');
    expect(scopeDefinition).toContain('password_setup_grant');

    const eventCheck = await pool.query<{ consrc: string }>(
      `SELECT pg_get_constraintdef(oid) AS consrc
       FROM pg_constraint
       WHERE conname = 'identity_security_events_type_valid'`,
    );
    const eventDefinition = eventCheck.rows[0]?.consrc ?? '';
    expect(eventDefinition).toContain('password_credential_changed');
    expect(eventDefinition).toContain('password_change_failed');
    expect(eventDefinition).toContain('password_credential_created');

    const reasonCheck = await pool.query<{ consrc: string }>(
      `SELECT pg_get_constraintdef(oid) AS consrc
       FROM pg_constraint
       WHERE conname = 'account_sessions_revocation_reason_valid'`,
    );
    const reasonDefinition = reasonCheck.rows[0]?.consrc ?? '';
    expect(reasonDefinition).toContain('password_changed');
    expect(reasonDefinition).toContain('passkey_revoked');

    const tables = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'town' AND table_name = 'password_change_attempts'
       ) AS exists`,
    );
    expect(tables.rows[0]?.exists).toBe(false);
  });

  it('upgrades in place from real post-0027 schema while preserving existing rows', async () => {
    tempMigrationFolder = await migrateThroughTag(
      pool,
      '0027_password_sign_in_ceremony_rate_limits',
    );

    const beforeCount = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM drizzle.__drizzle_migrations`,
    );
    expect(Number(beforeCount.rows[0]?.count ?? 0)).toBe(28);

    const existingRateLimitId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
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
        existingRateLimitId,
        existingSubjectHash,
        existingWindowStartedAt,
        existingWindowExpiresAt,
        existingAttemptCount,
        existingCreatedAt,
        existingUpdatedAt,
      ],
    );

    const existingEventId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const existingEventOccurredAt = '2026-07-01T00:03:00.000Z';
    await pool.query(
      `INSERT INTO town.identity_security_events (
         id, account_id, event_type, occurred_at, request_id, metadata
       ) VALUES (
         $1, NULL, 'password_credential_created', $2::timestamptz, NULL, '{}'::jsonb
       )`,
      [existingEventId, existingEventOccurredAt],
    );

    const existingAccountId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const accountReadyAt = '2026-07-01T00:04:00.000Z';
    const accountCreatedAt = '2026-07-01T00:04:00.000Z';
    await pool.query(
      `INSERT INTO town.accounts (
         id, status, created_at, updated_at, account_ready_at,
         suspended_at, closed_at, webauthn_user_handle
       ) VALUES (
         $1, 'active', $2::timestamptz, $2::timestamptz, $3::timestamptz,
         NULL, NULL, $4
       )`,
      [existingAccountId, accountCreatedAt, accountReadyAt, Buffer.alloc(32, 7)],
    );

    const existingSessionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const sessionCreatedAt = '2026-07-01T00:05:00.000Z';
    const sessionRevokedAt = '2026-07-01T00:06:00.000Z';
    await pool.query(
      `INSERT INTO town.account_sessions (
         id, account_id, token_hash, client_type, created_at, authenticated_at,
         last_seen_at, idle_expires_at, absolute_expires_at, revoked_at,
         revocation_reason, recovery_recent_at, authenticated_passkey_id,
         fresh_authenticated_at, security_version
       ) VALUES (
         $1, $2, $3, 'web', $4::timestamptz, $4::timestamptz,
         $4::timestamptz, $5::timestamptz, $6::timestamptz, $7::timestamptz,
         'logout', NULL, NULL, NULL, 1
       )`,
      [
        existingSessionId,
        existingAccountId,
        Buffer.alloc(32, 9),
        sessionCreatedAt,
        '2026-07-01T00:35:00.000Z',
        '2026-07-02T00:05:00.000Z',
        sessionRevokedAt,
      ],
    );

    const beforeRateLimit = await pool.query(
      `SELECT id, scope, subject_hash, attempt_count, created_at, updated_at
       FROM town.ceremony_rate_limits WHERE id = $1`,
      [existingRateLimitId],
    );
    const beforeEvent = await pool.query(
      `SELECT id, account_id, event_type, occurred_at FROM town.identity_security_events WHERE id = $1`,
      [existingEventId],
    );
    const beforeSession = await pool.query(
      `SELECT id, revocation_reason, authenticated_passkey_id FROM town.account_sessions WHERE id = $1`,
      [existingSessionId],
    );

    const db = drizzle(pool);
    await migrate(db, { migrationsFolder });

    const afterCount = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM drizzle.__drizzle_migrations`,
    );
    expect(Number(afterCount.rows[0]?.count ?? 0)).toBe(EXPECTED_MIGRATION_COUNT);
    expect(EXPECTED_MIGRATION_COUNT).toBe(42);

    const ordered = await pool.query<{ id: number }>(
      `SELECT id FROM drizzle.__drizzle_migrations ORDER BY id ASC`,
    );
    expect(ordered.rows).toHaveLength(42);

    const afterRateLimit = await pool.query(
      `SELECT id, scope, subject_hash, attempt_count, created_at, updated_at
       FROM town.ceremony_rate_limits WHERE id = $1`,
      [existingRateLimitId],
    );
    expect(afterRateLimit.rows).toEqual(beforeRateLimit.rows);

    const afterEvent = await pool.query(
      `SELECT id, account_id, event_type, occurred_at FROM town.identity_security_events WHERE id = $1`,
      [existingEventId],
    );
    expect(afterEvent.rows).toEqual(beforeEvent.rows);

    const afterSession = await pool.query(
      `SELECT id, revocation_reason, authenticated_passkey_id FROM town.account_sessions WHERE id = $1`,
      [existingSessionId],
    );
    expect(afterSession.rows).toEqual(beforeSession.rows);

    await expect(
      pool.query(
        `INSERT INTO town.ceremony_rate_limits (
           id, scope, subject_hash, window_started_at, window_expires_at,
           attempt_count, blocked_until, created_at, updated_at
         ) VALUES (
           'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'password_change_account', $1,
           '2026-07-02T00:00:00.000Z'::timestamptz, '2026-07-02T00:30:00.000Z'::timestamptz,
           1, NULL, '2026-07-02T00:00:00.000Z'::timestamptz, '2026-07-02T00:00:00.000Z'::timestamptz
         )`,
        [Buffer.alloc(32, 2)],
      ),
    ).resolves.toBeTruthy();

    await expect(
      pool.query(
        `INSERT INTO town.identity_security_events (
           id, account_id, event_type, occurred_at, request_id, metadata
         ) VALUES (
           'ffffffff-ffff-4fff-8fff-ffffffffffff', $1, 'password_credential_changed',
           '2026-07-02T00:00:00.000Z'::timestamptz, NULL, '{}'::jsonb
         )`,
        [existingAccountId],
      ),
    ).resolves.toBeTruthy();

    await expect(
      pool.query(
        `INSERT INTO town.identity_security_events (
           id, account_id, event_type, occurred_at, request_id, metadata
         ) VALUES (
           '11111111-1111-4111-8111-111111111111', $1, 'password_change_failed',
           '2026-07-02T00:00:00.000Z'::timestamptz, NULL, '{}'::jsonb
         )`,
        [existingAccountId],
      ),
    ).resolves.toBeTruthy();

    await expect(
      pool.query(
        `UPDATE town.account_sessions
         SET revocation_reason = 'password_changed'
         WHERE id = $1`,
        [existingSessionId],
      ),
    ).resolves.toBeTruthy();

    await expect(
      pool.query(
        `INSERT INTO town.ceremony_rate_limits (
           id, scope, subject_hash, window_started_at, window_expires_at,
           attempt_count, blocked_until, created_at, updated_at
         ) VALUES (
           '22222222-2222-4222-8222-222222222222', 'not_a_real_scope', $1,
           '2026-07-02T00:00:00.000Z'::timestamptz, '2026-07-02T00:30:00.000Z'::timestamptz,
           1, NULL, '2026-07-02T00:00:00.000Z'::timestamptz, '2026-07-02T00:00:00.000Z'::timestamptz
         )`,
        [Buffer.alloc(32, 3)],
      ),
    ).rejects.toThrow();

    const journal = JSON.parse(
      readFileSync(path.join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
    ) as Journal;
    for (const entry of journal.entries.slice(0, 28)) {
      const sql = readMigrationSql(entry.tag);
      expect(sql.length).toBeGreaterThan(0);
      expect(sql).not.toContain("'password_change_account'");
      expect(sql).not.toContain("'password_credential_changed'");
      expect(sql).not.toContain("'password_change_failed'");
    }
    // Prior migration files remain present and unmodified under their original tags.
    expect(journal.entries[0]?.tag).toBe('0000_create_town_schema');
    expect(journal.entries[27]?.tag).toBe('0027_password_sign_in_ceremony_rate_limits');
    expect(journal.entries[28]?.tag).toBe('0028_password_change_ceremony_runtime');
  });
});

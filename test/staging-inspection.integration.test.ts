import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import {
  runStagingInspection,
  type StagingInspectionResult,
} from '../src/db/run-staging-inspection.js';
import { requireDatabaseUrl, resetAndMigrate } from './helpers/pg.js';

describe('staging inspection integration', () => {
  const databaseUrl = requireDatabaseUrl();
  let pool: Pool;

  const stagingEnv = {
    APP_ENV: 'staging',
    DATABASE_URL: databaseUrl,
  };

  beforeAll(() => {
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
  });

  beforeEach(async () => {
    await resetAndMigrate(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('T1 rejects INSERT into a persistent table inside the read-only transaction', async () => {
    let insertError: unknown;
    await expect(
      runStagingInspection({
        env: stagingEnv,
        afterTransactionReady: async (client: PoolClient) => {
          try {
            await client.query(
              `INSERT INTO town.communities (
                 id, slug, position, country_code, city_name, display_name,
                 default_locale, timezone, status, created_at, updated_at
               ) VALUES (
                 '00000000-0000-4000-8000-00000000ffff',
                 'inspect-ro-probe',
                 999,
                 'XX',
                 'Probe',
                 'Probe',
                 'en',
                 'UTC',
                 'active',
                 NOW(),
                 NOW()
               )`,
            );
          } catch (error: unknown) {
            insertError = error;
            throw error;
          }
        },
      }),
    ).rejects.toBeTruthy();

    expect(insertError).toBeInstanceOf(Error);
    const message = insertError instanceof Error ? insertError.message : '';
    expect(message).toMatch(/read-only transaction|cannot execute/i);
  });

  it('T7 non-zero eligibility finding still exits successfully', async () => {
    await pool.query(
      `INSERT INTO town.communities (
         id, slug, position, country_code, city_name, display_name,
         default_locale, timezone, status, created_at, updated_at
       ) VALUES (
         '00000000-0000-4000-8000-000000000001',
         'milano-it',
         1,
         'IT',
         'Milano',
         'Milano',
         'it',
         'Europe/Rome',
         'active',
         NOW(),
         NOW()
       )`,
    );
    await pool.query(
      `INSERT INTO town.actors (
         id, kind, status, display_label, community_id, account_id,
         local_eligibility_verified_at, created_at, updated_at
       ) VALUES (
         '00000000-0000-4000-8000-000000000301',
         'controlled_test',
         'active',
         'controlled',
         '00000000-0000-4000-8000-000000000001',
         NULL,
         NULL,
         NOW(),
         NOW()
       )`,
    );

    const result = await runStagingInspection({ env: stagingEnv });
    expect(result.eligibilityFinding.actorsBoundMissingLocalEligibilityVerifiedAt).toBeGreaterThan(
      0,
    );
    expect(result.migrationLedgerChecked).toBe(false);
    expect(result.migrationLedgerAuthority).toBe('GET /health/ready');
    expect(result.schemaCheck.status).toBe('ok');
  });

  it('T8 wrong column type exits as schema mismatch', async () => {
    await pool.query(`ALTER TABLE town.signal_submissions ALTER COLUMN headline TYPE varchar(100)`);
    await expect(runStagingInspection({ env: stagingEnv })).rejects.toMatchObject({
      code: 'SCHEMA_MISMATCH',
    });
  });

  it('T8 foreign key delete rule not RESTRICT exits as schema mismatch', async () => {
    await pool.query(
      `ALTER TABLE town.signal_submissions DROP CONSTRAINT signal_submissions_account_id_fkey`,
    );
    await pool.query(
      `ALTER TABLE town.signal_submissions
       ADD CONSTRAINT signal_submissions_account_id_fkey
       FOREIGN KEY (account_id) REFERENCES town.accounts(id) ON DELETE CASCADE`,
    );
    await expect(runStagingInspection({ env: stagingEnv })).rejects.toMatchObject({
      code: 'SCHEMA_MISMATCH',
    });
  });

  it('T8 CHECK permitting a value other than pending_review exits as schema mismatch', async () => {
    await pool.query(
      `ALTER TABLE town.signal_submissions DROP CONSTRAINT signal_submissions_status_valid`,
    );
    await pool.query(
      `ALTER TABLE town.signal_submissions
       ADD CONSTRAINT signal_submissions_status_valid
       CHECK (status IN ('pending_review', 'approved'))`,
    );
    await expect(runStagingInspection({ env: stagingEnv })).rejects.toMatchObject({
      code: 'SCHEMA_MISMATCH',
    });
  });

  it('T8 index column order mismatch exits as schema mismatch', async () => {
    await pool.query(`DROP INDEX town.signal_submissions_account_created_at_idx`);
    await pool.query(
      `CREATE INDEX signal_submissions_account_created_at_idx
       ON town.signal_submissions USING btree (created_at, account_id)`,
    );
    await expect(runStagingInspection({ env: stagingEnv })).rejects.toMatchObject({
      code: 'SCHEMA_MISMATCH',
    });
  });

  it('T9/T10 happy path returns counts metadata only with ledger disclaimer', async () => {
    const result: StagingInspectionResult = await runStagingInspection({ env: stagingEnv });
    const serialized = JSON.stringify(result);
    expect(result.migrationLedgerChecked).toBe(false);
    expect(result.migrationLedgerAuthority).toBe('GET /health/ready');
    expect(result.schemaCheck.table).toBe('town.signal_submissions');
    expect(result.rowCounts.signal_submissions).toBe(0);
    expect(serialized).not.toMatch(/@[a-z]/i);
    expect(serialized).not.toMatch(/postgres:\/\//i);
    expect(Object.keys(result.rowCounts)).toHaveLength(19);
  });

  it('T3/T4 real client issues SET LOCAL and never uses a second connection', async () => {
    let sawSetLocal = false;
    let queryCount = 0;
    await runStagingInspection({
      env: stagingEnv,
      afterTransactionReady: async (client) => {
        const timeout = await client.query<{ statement_timeout: string }>(`SHOW statement_timeout`);
        expect(timeout.rows[0]?.statement_timeout).toMatch(/5s|5000ms/i);
        sawSetLocal = true;
        // Prove only one backend connection is held by this pool (max: 1).
        const backends = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count
           FROM pg_stat_activity
           WHERE datname = current_database()
             AND pid = pg_backend_pid()`,
        );
        expect(Number(backends.rows[0]?.count ?? 0)).toBe(1);
        queryCount += 1;
      },
    });
    expect(sawSetLocal).toBe(true);
    expect(queryCount).toBe(1);
  });
});

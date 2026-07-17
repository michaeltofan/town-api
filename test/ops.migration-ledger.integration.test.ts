import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkMigrationLedger,
  EXPECTED_MIGRATION_COUNT,
  EXPECTED_MIGRATIONS,
  type ExpectedMigration,
} from '../src/db/migration-ledger.js';
import { requireDatabaseUrl, resetAndMigrate } from './helpers/pg.js';

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsxBin = path.resolve(scriptRoot, 'node_modules', '.bin', 'tsx');

async function runNodeScript(
  script: string,
  args: readonly string[] = [],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(tsxBin, [path.resolve(scriptRoot, script), ...args], {
      cwd: scriptRoot,
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function snapshotLedger(pool: Pool): Promise<string> {
  const result = await pool.query<{ id: number; hash: string; created_at: string }>(
    `SELECT id, hash, created_at::text AS created_at
     FROM drizzle.__drizzle_migrations
     ORDER BY id ASC`,
  );
  return JSON.stringify(result.rows);
}

describe('migration ledger against real PostgreSQL', () => {
  const databaseUrl = requireDatabaseUrl();
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });

  beforeAll(async () => {
    await resetAndMigrate(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('reports ok when the ordered hash and timestamp sequence matches', async () => {
    const result = await checkMigrationLedger(pool, { timeoutMs: 5000 });
    expect(result.status).toBe('ok');
    expect(result.detail).toBe('ok');
    expect(result.expected).toBe(EXPECTED_MIGRATION_COUNT);
    expect(result.applied).toBe(EXPECTED_MIGRATION_COUNT);
  });

  it('db:migrate:verify is non-mutating and exits 0 on match', async () => {
    const before = await snapshotLedger(pool);
    const { code, stdout } = await runNodeScript('scripts/db-migrate-verify.ts');
    expect(code).toBe(0);
    expect(stdout).toContain('"status":"ok"');
    expect(stdout).toContain('"detail":"ok"');
    expect(stdout).toContain('Migration ledger OK');
    const after = await snapshotLedger(pool);
    expect(after).toBe(before);
  });

  it('reports unknown when the migrations table is missing', async () => {
    const isolated = new Pool({ connectionString: databaseUrl, max: 1 });
    try {
      await isolated.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
      const result = await checkMigrationLedger(isolated, { timeoutMs: 5000 });
      expect(result.status).toBe('unknown');
      expect(result.detail).toBe('unknown');
      expect(result.applied).toBe(0);
    } finally {
      await isolated.end();
      await resetAndMigrate(pool);
    }
  });

  it('reports fail/missing when an applied row is deleted', async () => {
    const before = await snapshotLedger(pool);
    try {
      await pool.query(
        `DELETE FROM drizzle.__drizzle_migrations
         WHERE id = (SELECT MAX(id) FROM drizzle.__drizzle_migrations)`,
      );
      const result = await checkMigrationLedger(pool, { timeoutMs: 5000 });
      expect(result.status).toBe('fail');
      expect(result.detail).toBe('missing');
      expect(result.applied).toBe(EXPECTED_MIGRATION_COUNT - 1);
    } finally {
      await resetAndMigrate(pool);
      expect(await snapshotLedger(pool)).toBe(before);
    }
  });

  it('reports fail/extra when an unexpected ledger row is present', async () => {
    const before = await snapshotLedger(pool);
    try {
      await pool.query(
        `INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
         VALUES ($1, $2)`,
        ['eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', 9_999_999_999_999],
      );
      const result = await checkMigrationLedger(pool, { timeoutMs: 5000 });
      expect(result.status).toBe('fail');
      expect(result.detail).toBe('extra');
    } finally {
      await resetAndMigrate(pool);
      expect(await snapshotLedger(pool)).toBe(before);
    }
  });

  it('reports fail/hash_mismatch for same count but different hash identity', async () => {
    const before = await snapshotLedger(pool);
    try {
      await pool.query(
        `UPDATE drizzle.__drizzle_migrations
         SET hash = $1
         WHERE id = (SELECT MAX(id) FROM drizzle.__drizzle_migrations)`,
        ['ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'],
      );
      const result = await checkMigrationLedger(pool, { timeoutMs: 5000 });
      expect(result.status).toBe('fail');
      expect(result.detail).toBe('hash_mismatch');
      expect(result.expected).toBe(result.applied);
    } finally {
      await resetAndMigrate(pool);
      expect(await snapshotLedger(pool)).toBe(before);
    }
  });

  it('reports fail/order_mismatch when applied hashes are a wrong-order permutation', async () => {
    const before = await snapshotLedger(pool);
    try {
      const rows = await pool.query<{ id: number; hash: string; created_at: string }>(
        `SELECT id, hash, created_at::text AS created_at
         FROM drizzle.__drizzle_migrations
         ORDER BY id ASC
         LIMIT 2`,
      );
      const first = rows.rows[0];
      const second = rows.rows[1];
      if (first === undefined || second === undefined) {
        throw new Error('need two ledger rows');
      }
      await pool.query(
        `UPDATE drizzle.__drizzle_migrations SET hash = $1, created_at = $2 WHERE id = $3`,
        [second.hash, second.created_at, first.id],
      );
      await pool.query(
        `UPDATE drizzle.__drizzle_migrations SET hash = $1, created_at = $2 WHERE id = $3`,
        [first.hash, first.created_at, second.id],
      );
      const result = await checkMigrationLedger(pool, { timeoutMs: 5000 });
      expect(result.status).toBe('fail');
      expect(result.detail).toBe('order_mismatch');
    } finally {
      await resetAndMigrate(pool);
      expect(await snapshotLedger(pool)).toBe(before);
    }
  });

  it('reports fail/malformed for duplicate hashes in the ledger', async () => {
    const before = await snapshotLedger(pool);
    try {
      const firstHash = EXPECTED_MIGRATIONS[0]?.hash;
      if (firstHash === undefined) {
        throw new Error('missing expected hash');
      }
      await pool.query(
        `UPDATE drizzle.__drizzle_migrations
         SET hash = $1
         WHERE id = (SELECT MAX(id) FROM drizzle.__drizzle_migrations)`,
        [firstHash],
      );
      const result = await checkMigrationLedger(pool, { timeoutMs: 5000 });
      expect(result.status).toBe('fail');
      expect(result.detail).toBe('malformed');
    } finally {
      await resetAndMigrate(pool);
      expect(await snapshotLedger(pool)).toBe(before);
    }
  });

  it('reports fail when the expected sequence is overridden to a different history', async () => {
    const altered: ExpectedMigration[] = EXPECTED_MIGRATIONS.map((row, index) =>
      index === 0
        ? {
            ...row,
            hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          }
        : row,
    );
    const result = await checkMigrationLedger(pool, {
      timeoutMs: 5000,
      expectedMigrations: altered,
    });
    expect(result.status).toBe('fail');
    expect(result.detail).toBe('hash_mismatch');
  });

  it('advisory-locked migration runners serialize concurrent invocations', async () => {
    const [a, b] = await Promise.all([
      runNodeScript('scripts/db-migrate.ts'),
      runNodeScript('scripts/db-migrate.ts'),
    ]);
    expect(a.code, `a: ${a.stderr}`).toBe(0);
    expect(b.code, `b: ${b.stderr}`).toBe(0);
    const result = await checkMigrationLedger(pool, { timeoutMs: 5000 });
    expect(result.status).toBe('ok');
    expect(result.applied).toBe(EXPECTED_MIGRATION_COUNT);
  }, 60_000);
});

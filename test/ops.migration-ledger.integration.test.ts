import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkMigrationLedger, EXPECTED_MIGRATION_COUNT } from '../src/db/migration-ledger.js';
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

describe('migration ledger against real PostgreSQL', () => {
  const databaseUrl = requireDatabaseUrl();
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });

  beforeAll(async () => {
    await resetAndMigrate(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('reports ok when the applied count equals the journal count', async () => {
    const result = await checkMigrationLedger(pool, { timeoutMs: 5000 });
    expect(result.status).toBe('ok');
    expect(result.expected).toBe(EXPECTED_MIGRATION_COUNT);
    expect(result.applied).toBe(EXPECTED_MIGRATION_COUNT);
  });

  it('db:migrate:verify script exits 0 and emits status ok', async () => {
    const { code, stdout } = await runNodeScript('scripts/db-migrate-verify.ts');
    expect(code).toBe(0);
    expect(stdout).toContain('"status":"ok"');
    expect(stdout).toContain('Migration ledger OK');
  });

  it('reports unknown when the migrations table is missing', async () => {
    // Point the ledger check at a fresh isolated schema by dropping the drizzle schema.
    const isolated = new Pool({ connectionString: databaseUrl, max: 1 });
    try {
      await isolated.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
      const result = await checkMigrationLedger(isolated, { timeoutMs: 5000 });
      expect(result.status).toBe('unknown');
      expect(result.applied).toBe(0);
    } finally {
      await isolated.end();
      await resetAndMigrate(pool);
    }
  });

  it('reports fail when the ledger reports a different count than expected', async () => {
    const result = await checkMigrationLedger(pool, {
      timeoutMs: 5000,
      expectedCount: EXPECTED_MIGRATION_COUNT + 1,
    });
    expect(result.status).toBe('fail');
  });

  it('advisory-locked migration runners serialize concurrent invocations', async () => {
    // Two concurrent runs against a database that is already fully migrated
    // must both succeed (no rows inserted twice), and both must complete
    // without errors thanks to the pg_advisory_lock in scripts/db-migrate.ts.
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

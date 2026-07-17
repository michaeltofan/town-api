import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

/**
 * Drizzle PostgreSQL migration ledger verification for `/health/ready` and
 * `db:migrate:verify`.
 *
 * Drizzle persists applied migrations in `drizzle.__drizzle_migrations` with:
 * - `id` (serial): applied order
 * - `hash` (text): SHA-256 hex digest of the full `.sql` file contents
 *   (same algorithm as `drizzle-orm/migrator` `readMigrationFiles`)
 * - `created_at` (bigint): journal `when` timestamp (`folderMillis`)
 *
 * Canonical comparison (ordered, fail-closed):
 * 1. Load expected sequence from `drizzle/meta/_journal.json` entry order,
 *    hashing each `${tag}.sql` with SHA-256 and pairing with journal `when`.
 * 2. Load applied rows `ORDER BY id ASC` (bounded to expected+1 rows).
 * 3. Compare length, then per-index `hash` and `created_at`.
 * 4. Detect missing, extra, hash mismatch (same-count/different-history),
 *    timestamp mismatch, order permutation, and malformed ledger rows.
 *
 * Never returns migration SQL, hashes, or tags to HTTP callers of
 * `/health/ready` — only `ok` | `fail` | `unknown` plus safe counts.
 */

export type MigrationJournalEntry = {
  readonly idx: number;
  readonly tag: string;
  readonly when: number;
};

export type MigrationJournal = {
  readonly entries: readonly MigrationJournalEntry[];
};

export type ExpectedMigration = {
  readonly tag: string;
  readonly hash: string;
  readonly createdAt: number;
};

export type AppliedMigration = {
  readonly id: number;
  readonly hash: string;
  readonly createdAt: number;
};

export type MigrationLedgerDetail =
  | 'ok'
  | 'missing'
  | 'extra'
  | 'hash_mismatch'
  | 'timestamp_mismatch'
  | 'order_mismatch'
  | 'malformed'
  | 'unknown'
  | 'timeout'
  | 'error';

function resolveRepoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..');
}

function resolveMigrationsFolder(): string {
  return path.resolve(resolveRepoRoot(), 'drizzle');
}

function resolveJournalPath(migrationsFolder: string = resolveMigrationsFolder()): string {
  return path.resolve(migrationsFolder, 'meta', '_journal.json');
}

function parseJournal(raw: string): MigrationJournal {
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as { entries?: unknown }).entries)
  ) {
    throw new Error('migration-ledger: journal is missing entries array');
  }
  const entries = (parsed as { entries: unknown[] }).entries.map((entry, index) => {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof (entry as { idx?: unknown }).idx !== 'number' ||
      typeof (entry as { tag?: unknown }).tag !== 'string' ||
      typeof (entry as { when?: unknown }).when !== 'number'
    ) {
      throw new Error(`migration-ledger: journal entry ${String(index)} is malformed`);
    }
    const value = entry as { idx: number; tag: string; when: number };
    return { idx: value.idx, tag: value.tag, when: value.when };
  });
  return { entries };
}

export function readMigrationJournal(
  journalPath: string = resolveJournalPath(),
): MigrationJournal {
  const raw = readFileSync(journalPath, 'utf8');
  return parseJournal(raw);
}

/**
 * Load the repository-expected migration sequence using the same hash
 * algorithm as Drizzle's migrator (`SHA-256` of the full SQL file bytes).
 */
export function loadExpectedMigrations(
  migrationsFolder: string = resolveMigrationsFolder(),
): ExpectedMigration[] {
  const journal = readMigrationJournal(resolveJournalPath(migrationsFolder));
  return journal.entries.map((entry) => {
    const sqlPath = path.resolve(migrationsFolder, `${entry.tag}.sql`);
    const query = readFileSync(sqlPath, 'utf8');
    const hash = createHash('sha256').update(query).digest('hex');
    return {
      tag: entry.tag,
      hash,
      createdAt: entry.when,
    };
  });
}

const CACHED_EXPECTED = loadExpectedMigrations();

export const EXPECTED_MIGRATIONS: readonly ExpectedMigration[] = CACHED_EXPECTED;
export const EXPECTED_MIGRATION_COUNT = EXPECTED_MIGRATIONS.length;

export type MigrationLedgerStatus = 'ok' | 'fail' | 'unknown';

export type MigrationLedgerResult = {
  readonly status: MigrationLedgerStatus;
  readonly expected: number;
  readonly applied: number;
  readonly detail: MigrationLedgerDetail;
};

export type MigrationLedgerOptions = {
  /** Override expected sequence (tests only). Defaults to journal+SQL hashes. */
  readonly expectedMigrations?: readonly ExpectedMigration[];
  readonly timeoutMs: number;
};

function sortedHashKey(hashes: readonly string[]): string {
  return [...hashes].sort().join('\0');
}

function isHashPermutation(
  expected: readonly ExpectedMigration[],
  applied: readonly AppliedMigration[],
): boolean {
  if (expected.length !== applied.length || expected.length === 0) {
    return false;
  }
  const sameMultiset =
    sortedHashKey(expected.map((row) => row.hash)) ===
    sortedHashKey(applied.map((row) => row.hash));
  if (!sameMultiset) {
    return false;
  }
  return expected.some((row, index) => row.hash !== applied[index]?.hash);
}

function validateAppliedRows(
  rows: readonly AppliedMigration[],
): MigrationLedgerDetail | null {
  const seenIds = new Set<number>();
  const seenHashes = new Set<string>();
  for (const row of rows) {
    if (
      !Number.isInteger(row.id) ||
      row.id <= 0 ||
      typeof row.hash !== 'string' ||
      row.hash.length === 0 ||
      !/^[a-f0-9]{64}$/i.test(row.hash) ||
      !Number.isFinite(row.createdAt)
    ) {
      return 'malformed';
    }
    if (seenIds.has(row.id) || seenHashes.has(row.hash.toLowerCase())) {
      return 'malformed';
    }
    seenIds.add(row.id);
    seenHashes.add(row.hash.toLowerCase());
  }
  // Applied `id` sequence must be strictly increasing in query order.
  for (let i = 1; i < rows.length; i += 1) {
    const prev = rows[i - 1];
    const curr = rows[i];
    if (prev === undefined || curr === undefined || curr.id <= prev.id) {
      return 'malformed';
    }
  }
  return null;
}

/**
 * Pure ordered comparison of expected (journal) vs applied (ledger) sequences.
 * Exported for unit tests; used by `checkMigrationLedger`.
 */
export function compareMigrationSequences(
  expected: readonly ExpectedMigration[],
  applied: readonly AppliedMigration[],
): MigrationLedgerResult {
  const expectedCount = expected.length;
  const appliedCount = applied.length;

  const malformed = validateAppliedRows(applied);
  if (malformed !== null) {
    return {
      status: 'fail',
      expected: expectedCount,
      applied: appliedCount,
      detail: malformed,
    };
  }

  if (appliedCount < expectedCount) {
    return {
      status: 'fail',
      expected: expectedCount,
      applied: appliedCount,
      detail: 'missing',
    };
  }

  if (appliedCount > expectedCount) {
    return {
      status: 'fail',
      expected: expectedCount,
      applied: appliedCount,
      detail: 'extra',
    };
  }

  if (isHashPermutation(expected, applied)) {
    return {
      status: 'fail',
      expected: expectedCount,
      applied: appliedCount,
      detail: 'order_mismatch',
    };
  }

  for (let i = 0; i < expectedCount; i += 1) {
    const want = expected[i];
    const got = applied[i];
    if (want === undefined || got === undefined) {
      return {
        status: 'fail',
        expected: expectedCount,
        applied: appliedCount,
        detail: 'malformed',
      };
    }
    if (got.hash.toLowerCase() !== want.hash.toLowerCase()) {
      return {
        status: 'fail',
        expected: expectedCount,
        applied: appliedCount,
        detail: 'hash_mismatch',
      };
    }
    if (got.createdAt !== want.createdAt) {
      return {
        status: 'fail',
        expected: expectedCount,
        applied: appliedCount,
        detail: 'timestamp_mismatch',
      };
    }
  }

  return {
    status: 'ok',
    expected: expectedCount,
    applied: appliedCount,
    detail: 'ok',
  };
}

type LedgerRow = {
  id: number;
  hash: string | null;
  created_at: string | null;
};

function parseAppliedRows(rows: readonly LedgerRow[]): AppliedMigration[] | 'malformed' {
  const applied: AppliedMigration[] = [];
  for (const row of rows) {
    if (
      typeof row.id !== 'number' ||
      !Number.isInteger(row.id) ||
      typeof row.hash !== 'string' ||
      row.hash.length === 0 ||
      row.created_at === null ||
      row.created_at === undefined
    ) {
      return 'malformed';
    }
    const createdAt = Number.parseInt(row.created_at, 10);
    if (!Number.isFinite(createdAt)) {
      return 'malformed';
    }
    applied.push({ id: row.id, hash: row.hash, createdAt });
  }
  return applied;
}

/**
 * Non-mutating ledger check. `unknown` when the drizzle migrations table does
 * not exist; `fail` when the ordered hash/timestamp sequence does not match;
 * `ok` when identical to the repository-expected sequence.
 */
export async function checkMigrationLedger(
  pool: Pool,
  options: MigrationLedgerOptions,
): Promise<MigrationLedgerResult> {
  const expected = options.expectedMigrations ?? EXPECTED_MIGRATIONS;
  const expectedCount = expected.length;
  // Fetch at most expected+1 rows so an oversized ledger is detected without
  // unbounded reads.
  const limit = expectedCount + 1;

  let timeoutId: NodeJS.Timeout | undefined;
  try {
    const queryPromise = pool.query<LedgerRow>(
      `SELECT id, hash, created_at::text AS created_at
       FROM drizzle.__drizzle_migrations
       ORDER BY id ASC
       LIMIT $1`,
      [limit],
    );
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error('MIGRATION_LEDGER_TIMEOUT'));
      }, options.timeoutMs);
    });
    const result = await Promise.race([queryPromise, timeoutPromise]);
    const parsed = parseAppliedRows(result.rows);
    if (parsed === 'malformed') {
      return {
        status: 'fail',
        expected: expectedCount,
        applied: result.rows.length,
        detail: 'malformed',
      };
    }
    return compareMigrationSequences(expected, parsed);
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: unknown }).code === '42P01'
    ) {
      // undefined_table — migrations have not been applied yet.
      return {
        status: 'unknown',
        expected: expectedCount,
        applied: 0,
        detail: 'unknown',
      };
    }
    if (error instanceof Error && error.message === 'MIGRATION_LEDGER_TIMEOUT') {
      return {
        status: 'fail',
        expected: expectedCount,
        applied: 0,
        detail: 'timeout',
      };
    }
    return {
      status: 'fail',
      expected: expectedCount,
      applied: 0,
      detail: 'error',
    };
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

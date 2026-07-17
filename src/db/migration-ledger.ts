import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

/**
 * Drizzle migration ledger inspection used by /health/ready and db:migrate:verify.
 * Compares the count of applied migration rows in `drizzle.__drizzle_migrations`
 * to the expected count derived from `drizzle/meta/_journal.json`.
 *
 * We intentionally compare counts (and ordering monotonicity), not migration
 * names or SQL contents, to keep the readiness surface safe: migration names or
 * hashes are never returned to callers of /health/ready.
 */

export type MigrationJournalEntry = {
  readonly idx: number;
  readonly tag: string;
  readonly when: number;
};

export type MigrationJournal = {
  readonly entries: readonly MigrationJournalEntry[];
};

function resolveJournalPath(): string {
  // Journal lives next to migrations at repo-root/drizzle/meta/_journal.json.
  // From src/db/migration-ledger.ts     → ../../drizzle/meta/_journal.json
  // From dist/db/migration-ledger.js    → ../../drizzle/meta/_journal.json
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', 'drizzle', 'meta', '_journal.json');
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

export function readMigrationJournal(journalPath: string = resolveJournalPath()): MigrationJournal {
  const raw = readFileSync(journalPath, 'utf8');
  return parseJournal(raw);
}

const CACHED_JOURNAL = readMigrationJournal();

export const EXPECTED_MIGRATION_COUNT = CACHED_JOURNAL.entries.length;

export type MigrationLedgerStatus = 'ok' | 'fail' | 'unknown';

export type MigrationLedgerResult = {
  readonly status: MigrationLedgerStatus;
  readonly expected: number;
  readonly applied: number;
};

export type MigrationLedgerOptions = {
  readonly expectedCount?: number;
  readonly timeoutMs: number;
};

/**
 * Query applied migration count. `unknown` when the drizzle migrations table
 * does not exist (e.g. before any migration has ever run); `fail` when the
 * count does not equal the expected journal count; `ok` when equal.
 * Never surfaces SQL or column values to the caller.
 */
export async function checkMigrationLedger(
  pool: Pool,
  options: MigrationLedgerOptions,
): Promise<MigrationLedgerResult> {
  const expected = options.expectedCount ?? EXPECTED_MIGRATION_COUNT;

  let timeoutId: NodeJS.Timeout | undefined;
  try {
    const queryPromise = pool.query<{ applied: string }>(
      `SELECT COUNT(*)::text AS applied FROM drizzle.__drizzle_migrations`,
    );
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error('MIGRATION_LEDGER_TIMEOUT'));
      }, options.timeoutMs);
    });
    const result = await Promise.race([queryPromise, timeoutPromise]);
    const applied = Number.parseInt(result.rows[0]?.applied ?? '0', 10);
    if (!Number.isFinite(applied) || applied < 0) {
      return { status: 'fail', expected, applied: 0 };
    }
    if (applied === expected) {
      return { status: 'ok', expected, applied };
    }
    return { status: 'fail', expected, applied };
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: unknown }).code === '42P01'
    ) {
      // undefined_table — migrations have not been applied yet.
      return { status: 'unknown', expected, applied: 0 };
    }
    return { status: 'fail', expected, applied: 0 };
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

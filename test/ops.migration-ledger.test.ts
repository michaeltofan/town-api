import { describe, expect, it } from 'vitest';
import {
  compareMigrationSequences,
  EXPECTED_MIGRATION_COUNT,
  EXPECTED_MIGRATIONS,
  loadExpectedMigrations,
  type AppliedMigration,
  type ExpectedMigration,
} from '../src/db/migration-ledger.js';

function appliedFromExpected(
  expected: readonly ExpectedMigration[],
  startId = 1,
): AppliedMigration[] {
  return expected.map((row, index) => ({
    id: startId + index,
    hash: row.hash,
    createdAt: row.createdAt,
  }));
}

describe('compareMigrationSequences', () => {
  const expected = EXPECTED_MIGRATIONS;

  it('reports ok for an exact ordered hash and timestamp match', () => {
    const result = compareMigrationSequences(expected, appliedFromExpected(expected));
    expect(result).toEqual({
      status: 'ok',
      expected: EXPECTED_MIGRATION_COUNT,
      applied: EXPECTED_MIGRATION_COUNT,
      detail: 'ok',
    });
  });

  it('detects a missing migration (shorter applied sequence)', () => {
    const applied = appliedFromExpected(expected).slice(0, -1);
    const result = compareMigrationSequences(expected, applied);
    expect(result.status).toBe('fail');
    expect(result.detail).toBe('missing');
    expect(result.applied).toBe(EXPECTED_MIGRATION_COUNT - 1);
  });

  it('detects an extra migration (longer applied sequence)', () => {
    const applied = [
      ...appliedFromExpected(expected),
      {
        id: EXPECTED_MIGRATION_COUNT + 1,
        hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        createdAt: 9_999_999_999_999,
      },
    ];
    const result = compareMigrationSequences(expected, applied);
    expect(result.status).toBe('fail');
    expect(result.detail).toBe('extra');
  });

  it('detects same count but different migration hash identity', () => {
    const applied = appliedFromExpected(expected);
    const last = applied[applied.length - 1];
    if (last === undefined) {
      throw new Error('expected non-empty applied');
    }
    applied[applied.length - 1] = {
      ...last,
      hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    };
    const result = compareMigrationSequences(expected, applied);
    expect(result.status).toBe('fail');
    expect(result.detail).toBe('hash_mismatch');
    expect(result.expected).toBe(result.applied);
  });

  it('detects same count but different created_at timestamp', () => {
    const applied = appliedFromExpected(expected);
    const mid = applied[2];
    if (mid === undefined) {
      throw new Error('expected mid row');
    }
    applied[2] = { ...mid, createdAt: mid.createdAt + 1 };
    const result = compareMigrationSequences(expected, applied);
    expect(result.status).toBe('fail');
    expect(result.detail).toBe('timestamp_mismatch');
  });

  it('detects wrong order when hashes are a permutation of the expected set', () => {
    const applied = appliedFromExpected(expected);
    if (applied.length < 2) {
      throw new Error('need at least two migrations');
    }
    const a = applied[0];
    const b = applied[1];
    if (a === undefined || b === undefined) {
      throw new Error('missing rows');
    }
    applied[0] = { ...a, hash: b.hash, createdAt: b.createdAt };
    applied[1] = { ...b, hash: a.hash, createdAt: a.createdAt };
    const result = compareMigrationSequences(expected, applied);
    expect(result.status).toBe('fail');
    expect(result.detail).toBe('order_mismatch');
  });

  it('detects malformed ledger rows (empty hash, bad id, duplicates)', () => {
    expect(
      compareMigrationSequences(expected, [
        { id: 1, hash: '', createdAt: expected[0]?.createdAt ?? 0 },
      ]).detail,
    ).toBe('malformed');

    expect(
      compareMigrationSequences(expected, [
        {
          id: 1,
          hash: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
          createdAt: Number.NaN,
        },
      ]).detail,
    ).toBe('malformed');

    const dupHash = expected[0]?.hash ?? 'dd'.repeat(32);
    expect(
      compareMigrationSequences(expected.slice(0, 2), [
        { id: 1, hash: dupHash, createdAt: 1 },
        { id: 2, hash: dupHash, createdAt: 2 },
      ]).detail,
    ).toBe('malformed');
  });

  it('loadExpectedMigrations matches the cached journal sequence', () => {
    const loaded = loadExpectedMigrations();
    expect(loaded).toEqual([...EXPECTED_MIGRATIONS]);
    expect(loaded).toHaveLength(29);
    for (const row of loaded) {
      expect(row.hash).toMatch(/^[a-f0-9]{64}$/);
      expect(row.tag.length).toBeGreaterThan(0);
      expect(Number.isFinite(row.createdAt)).toBe(true);
    }
  });
});

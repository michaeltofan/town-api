import type { Database } from '../../src/db/client.js';
import type { DatabaseConnectionStatus } from '../../src/db/lifecycle.js';
import type { MigrationLedgerResult } from '../../src/db/migration-ledger.js';
import { EXPECTED_MIGRATION_COUNT } from '../../src/db/migration-ledger.js';

export type FakeDatabase = Database & {
  readinessCalls: number;
  closed: boolean;
};

export function createFakeDatabase(options?: {
  ready?: boolean;
  connectionStatus?: DatabaseConnectionStatus;
  migrationStatus?: MigrationLedgerResult['status'];
  onCheckReadiness?: () => void;
}): FakeDatabase {
  const state = {
    readinessCalls: 0,
    closed: false,
  };

  const ready = options?.ready ?? true;
  const connectionStatus: DatabaseConnectionStatus =
    options?.connectionStatus ?? (ready ? 'ok' : 'fail');
  const migrationStatus = options?.migrationStatus ?? (ready ? 'ok' : 'fail');

  const migrationResult: MigrationLedgerResult = {
    status: migrationStatus,
    expected: EXPECTED_MIGRATION_COUNT,
    applied: migrationStatus === 'ok' ? EXPECTED_MIGRATION_COUNT : 0,
  };

  const database: FakeDatabase = {
    pool: undefined as unknown as Database['pool'],
    db: undefined as unknown as Database['db'],
    checkReadiness: () => {
      state.readinessCalls += 1;
      options?.onCheckReadiness?.();
      return Promise.resolve(ready);
    },
    checkConnection: () => Promise.resolve(connectionStatus),
    checkMigrations: () => Promise.resolve(migrationResult),
    close: () => {
      state.closed = true;
      return Promise.resolve();
    },
    get readinessCalls() {
      return state.readinessCalls;
    },
    get closed() {
      return state.closed;
    },
  };

  return database;
}

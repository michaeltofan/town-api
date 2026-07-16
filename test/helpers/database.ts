import type { Database } from '../../src/db/client.js';

export type FakeDatabase = Database & {
  readinessCalls: number;
  closed: boolean;
};

export function createFakeDatabase(options?: {
  ready?: boolean;
  onCheckReadiness?: () => void;
}): FakeDatabase {
  const state = {
    readinessCalls: 0,
    closed: false,
  };

  const database: FakeDatabase = {
    pool: undefined as unknown as Database['pool'],
    db: undefined as unknown as Database['db'],
    checkReadiness: () => {
      state.readinessCalls += 1;
      options?.onCheckReadiness?.();
      return Promise.resolve(options?.ready ?? true);
    },
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

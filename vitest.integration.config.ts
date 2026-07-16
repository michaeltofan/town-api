import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'test/database.test.ts',
      'test/readiness.test.ts',
      'test/communities-signals.migration.test.ts',
      'test/communities-signals.seed.test.ts',
      'test/communities-signals.constraints.test.ts',
      'test/communities-signals.repository.test.ts',
      'test/communities-signals.api.test.ts',
    ],
    fileParallelism: false,
    poolOptions: {
      threads: {
        singleThread: true,
      },
    },
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/database.test.ts', 'test/readiness.test.ts'],
    fileParallelism: false,
    poolOptions: {
      threads: {
        singleThread: true,
      },
    },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

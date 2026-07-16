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
      'test/signal-confirmation.migration.test.ts',
      'test/signal-confirmation.seed.test.ts',
      'test/signal-confirmation.repository.test.ts',
      'test/signal-confirmation.api.test.ts',
      'test/signal-confirmation.persistence.test.ts',
      'test/signal-confirmation.access.test.ts',
      'test/account-identity.migration.test.ts',
      'test/account-identity.repository.test.ts',
      'test/account-identity.fixtures.test.ts',
      'test/auth-ceremony.migration.test.ts',
      'test/auth-ceremony.repository.test.ts',
      'test/auth-ceremony.fixtures.test.ts',
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

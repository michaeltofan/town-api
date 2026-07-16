import { loadEnv, type Env } from '../../src/config/env.js';

const PLACEHOLDER_DATABASE_URL = 'postgres://town:town@127.0.0.1:5432/town_placeholder';

export function createTestEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): Env {
  return loadEnv({
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: '3000',
    LOG_LEVEL: 'silent',
    DATABASE_URL: PLACEHOLDER_DATABASE_URL,
    DB_POOL_MAX: '5',
    DB_CONNECTION_TIMEOUT_MS: '2000',
    DB_IDLE_TIMEOUT_MS: '1000',
    CONTROLLED_CONFIRMATION_ENABLED: 'false',
    ...overrides,
  });
}

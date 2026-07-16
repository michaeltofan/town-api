import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';

describe('loadEnv', () => {
  it('applies defaults for optional values when DATABASE_URL is present', () => {
    const env = loadEnv({
      DATABASE_URL: 'postgres://town:town@127.0.0.1:5432/town',
    });

    expect(env).toEqual({
      NODE_ENV: 'development',
      HOST: '0.0.0.0',
      PORT: 3000,
      LOG_LEVEL: 'info',
      DATABASE_URL: 'postgres://town:town@127.0.0.1:5432/town',
      DB_POOL_MAX: 5,
      DB_CONNECTION_TIMEOUT_MS: 5000,
      DB_IDLE_TIMEOUT_MS: 30000,
      CONTROLLED_CONFIRMATION_ENABLED: false,
    });
  });

  it('parses provided values', () => {
    const env = loadEnv({
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: '8080',
      LOG_LEVEL: 'warn',
      DATABASE_URL: 'postgres://town:town@127.0.0.1:5432/town',
      DB_POOL_MAX: '3',
      DB_CONNECTION_TIMEOUT_MS: '1500',
      DB_IDLE_TIMEOUT_MS: '12000',
      CONTROLLED_CONFIRMATION_ENABLED: 'false',
    });

    expect(env).toEqual({
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: 8080,
      LOG_LEVEL: 'warn',
      DATABASE_URL: 'postgres://town:town@127.0.0.1:5432/town',
      DB_POOL_MAX: 3,
      DB_CONNECTION_TIMEOUT_MS: 1500,
      DB_IDLE_TIMEOUT_MS: 12000,
      CONTROLLED_CONFIRMATION_ENABLED: false,
    });
  });

  it('requires key and actor id when controlled confirmation is enabled', () => {
    const env = loadEnv({
      DATABASE_URL: 'postgres://town:town@127.0.0.1:5432/town',
      CONTROLLED_CONFIRMATION_ENABLED: 'true',
      CONTROLLED_CONFIRMATION_KEY: 'local-placeholder-key',
      CONTROLLED_TEST_ACTOR_ID: '00000000-0000-4000-8000-000000000301',
    });

    expect(env.CONTROLLED_CONFIRMATION_ENABLED).toBe(true);
    expect(env.CONTROLLED_CONFIRMATION_KEY).toBe('local-placeholder-key');
    expect(env.CONTROLLED_TEST_ACTOR_ID).toBe('00000000-0000-4000-8000-000000000301');
  });

  it('rejects enabled controlled confirmation without key and does not leak secrets', () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: 'postgres://town:town@127.0.0.1:5432/town',
        CONTROLLED_CONFIRMATION_ENABLED: 'true',
        CONTROLLED_TEST_ACTOR_ID: '00000000-0000-4000-8000-000000000301',
      }),
    ).toThrow(/CONTROLLED_CONFIRMATION_KEY is required/);
  });

  it('rejects malformed configured actor id without leaking the value', () => {
    const badActorId = 'not-a-uuid-secret-actor';
    expect(() =>
      loadEnv({
        DATABASE_URL: 'postgres://town:town@127.0.0.1:5432/town',
        CONTROLLED_CONFIRMATION_ENABLED: 'true',
        CONTROLLED_CONFIRMATION_KEY: 'local-placeholder-key',
        CONTROLLED_TEST_ACTOR_ID: badActorId,
      }),
    ).toThrow(/CONTROLLED_TEST_ACTOR_ID must be a valid UUID/);

    try {
      loadEnv({
        DATABASE_URL: 'postgres://town:town@127.0.0.1:5432/town',
        CONTROLLED_CONFIRMATION_ENABLED: 'true',
        CONTROLLED_CONFIRMATION_KEY: 'super-secret-control-key',
        CONTROLLED_TEST_ACTOR_ID: badActorId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      expect(message).not.toContain('super-secret-control-key');
      expect(message).not.toContain(badActorId);
    }
  });

  it('rejects invalid CONTROLLED_CONFIRMATION_ENABLED values', () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: 'postgres://town:town@127.0.0.1:5432/town',
        CONTROLLED_CONFIRMATION_ENABLED: 'yes',
      }),
    ).toThrow(/CONTROLLED_CONFIRMATION_ENABLED must be true or false/);
  });

  it('rejects missing DATABASE_URL without leaking values', () => {
    expect(() => loadEnv({})).toThrow(/DATABASE_URL is required/);
  });

  it('rejects invalid PORT values without leaking secrets', () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: 'postgres://secret-user:secret-pass@db.example:5432/town',
        PORT: 'not-a-number',
      }),
    ).toThrow(/Invalid environment configuration/);

    try {
      loadEnv({
        DATABASE_URL: 'postgres://secret-user:secret-pass@db.example:5432/town',
        PORT: 'not-a-number',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      expect(message).not.toContain('secret-user');
      expect(message).not.toContain('secret-pass');
      expect(message).not.toContain('db.example');
    }
  });

  it('rejects invalid pool bounds', () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: 'postgres://town:town@127.0.0.1:5432/town',
        DB_POOL_MAX: '0',
      }),
    ).toThrow(/Invalid environment configuration/);
  });
});

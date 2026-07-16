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
    });
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

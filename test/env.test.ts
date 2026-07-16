import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';

describe('loadEnv', () => {
  it('applies defaults for missing values', () => {
    const env = loadEnv({});

    expect(env).toEqual({
      NODE_ENV: 'development',
      HOST: '0.0.0.0',
      PORT: 3000,
      LOG_LEVEL: 'info',
    });
  });

  it('parses provided values', () => {
    const env = loadEnv({
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: '8080',
      LOG_LEVEL: 'warn',
    });

    expect(env).toEqual({
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: 8080,
      LOG_LEVEL: 'warn',
    });
  });

  it('rejects invalid PORT values', () => {
    expect(() =>
      loadEnv({
        PORT: 'not-a-number',
      }),
    ).toThrow(/Invalid environment configuration/);
  });
});

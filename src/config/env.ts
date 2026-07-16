import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const EnvSchema = Type.Object(
  {
    NODE_ENV: Type.Union(
      [Type.Literal('development'), Type.Literal('test'), Type.Literal('production')],
      { default: 'development' },
    ),
    HOST: Type.String({ default: '0.0.0.0' }),
    PORT: Type.Integer({ minimum: 1, maximum: 65535, default: 3000 }),
    LOG_LEVEL: Type.Union(
      [
        Type.Literal('fatal'),
        Type.Literal('error'),
        Type.Literal('warn'),
        Type.Literal('info'),
        Type.Literal('debug'),
        Type.Literal('trace'),
        Type.Literal('silent'),
      ],
      { default: 'info' },
    ),
    DATABASE_URL: Type.String({ minLength: 1 }),
    DB_POOL_MAX: Type.Integer({ minimum: 1, maximum: 50, default: 5 }),
    DB_CONNECTION_TIMEOUT_MS: Type.Integer({ minimum: 1, maximum: 60_000, default: 5_000 }),
    DB_IDLE_TIMEOUT_MS: Type.Integer({ minimum: 1, maximum: 300_000, default: 30_000 }),
  },
  { additionalProperties: false },
);

export type Env = Static<typeof EnvSchema>;

function parseInteger(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : Number.NaN;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const candidate = {
    NODE_ENV: source.NODE_ENV ?? 'development',
    HOST: source.HOST ?? '0.0.0.0',
    PORT: source.PORT === undefined ? 3000 : parseInteger(source.PORT),
    LOG_LEVEL: source.LOG_LEVEL ?? 'info',
    DATABASE_URL: source.DATABASE_URL,
    DB_POOL_MAX: source.DB_POOL_MAX === undefined ? 5 : parseInteger(source.DB_POOL_MAX),
    DB_CONNECTION_TIMEOUT_MS:
      source.DB_CONNECTION_TIMEOUT_MS === undefined
        ? 5_000
        : parseInteger(source.DB_CONNECTION_TIMEOUT_MS),
    DB_IDLE_TIMEOUT_MS:
      source.DB_IDLE_TIMEOUT_MS === undefined ? 30_000 : parseInteger(source.DB_IDLE_TIMEOUT_MS),
  };

  if (!isNonEmptyString(candidate.DATABASE_URL)) {
    throw new Error('Invalid environment configuration: DATABASE_URL is required');
  }

  if (!Value.Check(EnvSchema, candidate)) {
    const details = [...Value.Errors(EnvSchema, candidate)]
      .map((error) => {
        const path = error.path || '/env';
        // Never include raw environment values in error messages.
        if (path.includes('DATABASE_URL')) {
          return `${path}: must be a non-empty connection string`;
        }
        return `${path}: ${error.message}`;
      })
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }

  return candidate;
}

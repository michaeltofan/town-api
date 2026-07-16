import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const EnvSchema = Type.Object(
  {
    NODE_ENV: Type.Union(
      [Type.Literal('development'), Type.Literal('test'), Type.Literal('production')],
      { default: 'development' },
    ),
    HOST: Type.String({ default: '0.0.0.0' }),
    PORT: Type.Integer({ minimum: 1, default: 3000 }),
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
  },
  { additionalProperties: false },
);

export type Env = Static<typeof EnvSchema>;

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : Number.NaN;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const candidate = {
    NODE_ENV: source.NODE_ENV ?? 'development',
    HOST: source.HOST ?? '0.0.0.0',
    PORT: source.PORT === undefined ? 3000 : parsePort(source.PORT),
    LOG_LEVEL: source.LOG_LEVEL ?? 'info',
  };

  if (!Value.Check(EnvSchema, candidate)) {
    const details = [...Value.Errors(EnvSchema, candidate)]
      .map((error) => `${error.path || '/env'}: ${error.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }

  return candidate;
}

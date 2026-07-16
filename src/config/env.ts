import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  CEREMONY_RATE_LIMIT_HASH_KEY_MIN_LENGTH,
  EMAIL_VERIFICATION_HASH_KEY_MIN_LENGTH,
} from '../ceremony/email-verification/policy.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
    CONTROLLED_CONFIRMATION_ENABLED: Type.Boolean({ default: false }),
    CONTROLLED_CONFIRMATION_KEY: Type.Optional(Type.String({ minLength: 1 })),
    // UUID format is validated explicitly below; TypeBox FormatRegistry is not required here.
    CONTROLLED_TEST_ACTOR_ID: Type.Optional(Type.String({ minLength: 36, maxLength: 36 })),
    EMAIL_VERIFICATION_ENABLED: Type.Boolean({ default: false }),
    EMAIL_VERIFICATION_HASH_KEY: Type.Optional(
      Type.String({ minLength: EMAIL_VERIFICATION_HASH_KEY_MIN_LENGTH }),
    ),
    EMAIL_VERIFICATION_DELIVERY_MODE: Type.Optional(
      Type.Union([Type.Literal('test'), Type.Literal('development')]),
    ),
    CEREMONY_RATE_LIMIT_HASH_KEY: Type.Optional(
      Type.String({ minLength: CEREMONY_RATE_LIMIT_HASH_KEY_MIN_LENGTH }),
    ),
    TRUST_PROXY: Type.Boolean({ default: false }),
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

function parseBooleanFlag(value: string | undefined, fieldName: string): boolean {
  if (value === undefined || value === '') {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }

  throw new Error(`Invalid environment configuration: ${fieldName} must be true or false`);
}

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function sanitizeEnvErrorPath(path: string, message: string): string {
  // Never include raw secret or connection values in error messages.
  if (path.includes('DATABASE_URL')) {
    return `${path}: must be a non-empty connection string`;
  }
  if (path.includes('CONTROLLED_CONFIRMATION_KEY')) {
    return `${path}: must be a non-empty string when controlled confirmation is enabled`;
  }
  if (path.includes('CONTROLLED_TEST_ACTOR_ID')) {
    return `${path}: must be a valid UUID when controlled confirmation is enabled`;
  }
  if (path.includes('EMAIL_VERIFICATION_HASH_KEY')) {
    return `${path}: must meet minimum length when email verification is enabled`;
  }
  if (path.includes('CEREMONY_RATE_LIMIT_HASH_KEY')) {
    return `${path}: must meet minimum length when email verification is enabled`;
  }
  if (path.includes('EMAIL_VERIFICATION_DELIVERY_MODE')) {
    return `${path}: must be test or development when email verification is enabled`;
  }
  return `${path}: ${message}`;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const controlledEnabled = parseBooleanFlag(
    source.CONTROLLED_CONFIRMATION_ENABLED,
    'CONTROLLED_CONFIRMATION_ENABLED',
  );
  const emailVerificationEnabled = parseBooleanFlag(
    source.EMAIL_VERIFICATION_ENABLED,
    'EMAIL_VERIFICATION_ENABLED',
  );
  const trustProxy = parseBooleanFlag(source.TRUST_PROXY, 'TRUST_PROXY');
  const nodeEnv = source.NODE_ENV ?? 'development';

  const candidate: Record<string, unknown> = {
    NODE_ENV: nodeEnv,
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
    CONTROLLED_CONFIRMATION_ENABLED: controlledEnabled,
    EMAIL_VERIFICATION_ENABLED: emailVerificationEnabled,
    TRUST_PROXY: trustProxy,
  };

  if (controlledEnabled) {
    if (!isNonEmptyString(source.CONTROLLED_CONFIRMATION_KEY)) {
      throw new Error(
        'Invalid environment configuration: CONTROLLED_CONFIRMATION_KEY is required when CONTROLLED_CONFIRMATION_ENABLED is true',
      );
    }
    if (!isNonEmptyString(source.CONTROLLED_TEST_ACTOR_ID)) {
      throw new Error(
        'Invalid environment configuration: CONTROLLED_TEST_ACTOR_ID is required when CONTROLLED_CONFIRMATION_ENABLED is true',
      );
    }
    if (!isUuid(source.CONTROLLED_TEST_ACTOR_ID)) {
      throw new Error(
        'Invalid environment configuration: CONTROLLED_TEST_ACTOR_ID must be a valid UUID',
      );
    }
    candidate.CONTROLLED_CONFIRMATION_KEY = source.CONTROLLED_CONFIRMATION_KEY;
    candidate.CONTROLLED_TEST_ACTOR_ID = source.CONTROLLED_TEST_ACTOR_ID;
  }

  if (emailVerificationEnabled) {
    if (nodeEnv === 'production') {
      throw new Error(
        'Invalid environment configuration: EMAIL_VERIFICATION_ENABLED cannot be true in production while only test/development delivery adapters exist',
      );
    }
    if (!isNonEmptyString(source.EMAIL_VERIFICATION_HASH_KEY)) {
      throw new Error(
        'Invalid environment configuration: EMAIL_VERIFICATION_HASH_KEY is required when EMAIL_VERIFICATION_ENABLED is true',
      );
    }
    if (source.EMAIL_VERIFICATION_HASH_KEY.length < EMAIL_VERIFICATION_HASH_KEY_MIN_LENGTH) {
      throw new Error(
        `Invalid environment configuration: EMAIL_VERIFICATION_HASH_KEY must be at least ${String(EMAIL_VERIFICATION_HASH_KEY_MIN_LENGTH)} characters`,
      );
    }
    if (!isNonEmptyString(source.CEREMONY_RATE_LIMIT_HASH_KEY)) {
      throw new Error(
        'Invalid environment configuration: CEREMONY_RATE_LIMIT_HASH_KEY is required when EMAIL_VERIFICATION_ENABLED is true',
      );
    }
    if (source.CEREMONY_RATE_LIMIT_HASH_KEY.length < CEREMONY_RATE_LIMIT_HASH_KEY_MIN_LENGTH) {
      throw new Error(
        `Invalid environment configuration: CEREMONY_RATE_LIMIT_HASH_KEY must be at least ${String(CEREMONY_RATE_LIMIT_HASH_KEY_MIN_LENGTH)} characters`,
      );
    }
    const deliveryMode = source.EMAIL_VERIFICATION_DELIVERY_MODE;
    if (deliveryMode !== 'test' && deliveryMode !== 'development') {
      throw new Error(
        'Invalid environment configuration: EMAIL_VERIFICATION_DELIVERY_MODE must be test or development when EMAIL_VERIFICATION_ENABLED is true',
      );
    }
    candidate.EMAIL_VERIFICATION_HASH_KEY = source.EMAIL_VERIFICATION_HASH_KEY;
    candidate.CEREMONY_RATE_LIMIT_HASH_KEY = source.CEREMONY_RATE_LIMIT_HASH_KEY;
    candidate.EMAIL_VERIFICATION_DELIVERY_MODE = deliveryMode;
  }

  if (!isNonEmptyString(candidate.DATABASE_URL)) {
    throw new Error('Invalid environment configuration: DATABASE_URL is required');
  }

  if (!Value.Check(EnvSchema, candidate)) {
    const details = [...Value.Errors(EnvSchema, candidate)]
      .map((error) => sanitizeEnvErrorPath(error.path || '/env', error.message))
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }

  return Value.Decode(EnvSchema, candidate);
}

import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  CEREMONY_RATE_LIMIT_HASH_KEY_MIN_LENGTH,
  EMAIL_VERIFICATION_HASH_KEY_MIN_LENGTH,
} from '../ceremony/email-verification/policy.js';
import {
  ACCOUNT_RECOVERY_HASH_KEY_MIN_LENGTH,
  ACCOUNT_RECOVERY_TOKEN_HASH_KEY_MIN_LENGTH,
} from '../ceremony/account-recovery/policy.js';
import {
  assertProductionWebAuthnPolicy,
  parseAllowedOrigins,
} from '../ceremony/passkey-registration/config.js';
import {
  DEFAULT_WEB_SESSION_COOKIE_NAME,
  PASSKEY_AUTHENTICATION_CHALLENGE_HASH_KEY_MIN_LENGTH,
  SESSION_TOKEN_HASH_KEY_MIN_LENGTH,
} from '../ceremony/passkey-authentication/policy.js';
import {
  DEFAULT_WEBAUTHN_RP_NAME,
  WEBAUTHN_CHALLENGE_HASH_KEY_MIN_LENGTH,
} from '../ceremony/passkey-registration/policy.js';
import { PASSWORD_HASH_PEPPER_MIN_LENGTH } from '../identity/password-policy.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Pinned Stripe API version; must match env `STRIPE_API_VERSION` when billing is enabled. */
export const STRIPE_API_VERSION = '2026-06-24.dahlia' as const;
export type StripeApiVersion = typeof STRIPE_API_VERSION;

const EnvSchema = Type.Object(
  {
    NODE_ENV: Type.Union(
      [Type.Literal('development'), Type.Literal('test'), Type.Literal('production')],
      { default: 'development' },
    ),
    APP_ENV: Type.Union(
      [
        Type.Literal('development'),
        Type.Literal('test'),
        Type.Literal('staging'),
        Type.Literal('production'),
      ],
      { default: 'development' },
    ),
    /** Explicit fallback commit identity (CI / non-Git deployments). Full 40-char lowercase hex. */
    APP_COMMIT_SHA: Type.Optional(Type.String({ pattern: '^[0-9a-f]{40}$' })),
    /**
     * Railway-provided Git deployment commit SHA (runtime). Authoritative when set.
     * Full 40-char lowercase hex. Not baked into the Docker image.
     */
    RAILWAY_GIT_COMMIT_SHA: Type.Optional(Type.String({ pattern: '^[0-9a-f]{40}$' })),
    APP_BUILD_TIMESTAMP: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    READINESS_TIMEOUT_MS: Type.Integer({ minimum: 100, maximum: 60_000, default: 3_000 }),
    GRACEFUL_SHUTDOWN_TIMEOUT_MS: Type.Integer({
      minimum: 100,
      maximum: 120_000,
      default: 10_000,
    }),
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
    /**
     * Platform-managed Postgres backup attestation (Railway PITR).
     * Does not run dump jobs; surfaces automated PITR config for operator verification.
     */
    DATABASE_BACKUP_PROVIDER: Type.Union(
      [Type.Literal('none'), Type.Literal('railway_postgres_pitr')],
      { default: 'none' },
    ),
    DATABASE_BACKUP_PITR_ENABLED: Type.Boolean({ default: false }),
    DATABASE_BACKUP_RETENTION_DAYS: Type.Optional(Type.Integer({ minimum: 1, maximum: 365 })),
    /** Max age of the latest operator verification before backup status is degraded. */
    DATABASE_BACKUP_VERIFY_MAX_AGE_DAYS: Type.Integer({ minimum: 1, maximum: 365, default: 30 }),
    /**
     * Max age of the latest passed restore-drill attestation before restore status
     * is degraded. Attestation only — the API never executes database restore.
     */
    DATABASE_RESTORE_DRILL_MAX_AGE_DAYS: Type.Integer({ minimum: 1, maximum: 365, default: 90 }),
    CONTROLLED_CONFIRMATION_ENABLED: Type.Boolean({ default: false }),
    CONTROLLED_CONFIRMATION_KEY: Type.Optional(Type.String({ minLength: 1 })),
    // UUID format is validated explicitly below; TypeBox FormatRegistry is not required here.
    CONTROLLED_TEST_ACTOR_ID: Type.Optional(Type.String({ minLength: 36, maxLength: 36 })),
    /**
     * Optional CLI-only secrets for account:mark-owner. Never required at app boot.
     * loadEnv does not copy these into the runtime Env object; only the mark-owner
     * command reads process.env.OWNER_SETUP_CODE / OWNER_SETUP_CODE_EXPECTED.
     */
    OWNER_SETUP_CODE: Type.Optional(Type.String({ minLength: 128, maxLength: 128 })),
    OWNER_SETUP_CODE_EXPECTED: Type.Optional(Type.String({ minLength: 128, maxLength: 128 })),
    /**
     * Temporary staging-only override: when true, allows exact
     * https://towncivic.org in WEBAUTHN_ALLOWED_ORIGINS under APP_ENV=staging.
     * Default false (fail-closed). No effect when APP_ENV=production.
     */
    ALLOW_PRODUCTION_WEB_ORIGIN: Type.Boolean({ default: false }),
    EMAIL_VERIFICATION_ENABLED: Type.Boolean({ default: false }),
    EMAIL_VERIFICATION_HASH_KEY: Type.Optional(
      Type.String({ minLength: EMAIL_VERIFICATION_HASH_KEY_MIN_LENGTH }),
    ),
    EMAIL_VERIFICATION_DELIVERY_MODE: Type.Optional(
      Type.Union([Type.Literal('test'), Type.Literal('development'), Type.Literal('resend')]),
    ),
    EMAIL_VERIFICATION_RESEND_API_KEY: Type.Optional(Type.String({ minLength: 20 })),
    EMAIL_VERIFICATION_FROM_ADDRESS: Type.Optional(Type.String({ minLength: 3, maxLength: 320 })),
    EMAIL_VERIFICATION_REPLY_TO: Type.Optional(Type.String({ minLength: 3, maxLength: 320 })),
    CEREMONY_RATE_LIMIT_HASH_KEY: Type.Optional(
      Type.String({ minLength: CEREMONY_RATE_LIMIT_HASH_KEY_MIN_LENGTH }),
    ),
    WEBAUTHN_REGISTRATION_ENABLED: Type.Boolean({ default: false }),
    WEBAUTHN_RP_ID: Type.Optional(Type.String({ minLength: 1 })),
    WEBAUTHN_RP_NAME: Type.Optional(Type.String({ minLength: 1 })),
    WEBAUTHN_ALLOWED_ORIGINS: Type.Optional(Type.String({ minLength: 1 })),
    WEBAUTHN_CHALLENGE_HASH_KEY: Type.Optional(
      Type.String({ minLength: WEBAUTHN_CHALLENGE_HASH_KEY_MIN_LENGTH }),
    ),
    PASSKEY_AUTHENTICATION_ENABLED: Type.Boolean({ default: false }),
    PASSKEY_AUTHENTICATION_CHALLENGE_HASH_KEY: Type.Optional(
      Type.String({ minLength: PASSKEY_AUTHENTICATION_CHALLENGE_HASH_KEY_MIN_LENGTH }),
    ),
    SESSION_TOKEN_HASH_KEY: Type.Optional(
      Type.String({ minLength: SESSION_TOKEN_HASH_KEY_MIN_LENGTH }),
    ),
    WEB_SESSION_COOKIE_NAME: Type.Optional(Type.String({ minLength: 1 })),
    ACCOUNT_RECOVERY_ENABLED: Type.Boolean({ default: false }),
    ACCOUNT_RECOVERY_HASH_KEY: Type.Optional(
      Type.String({ minLength: ACCOUNT_RECOVERY_HASH_KEY_MIN_LENGTH }),
    ),
    ACCOUNT_RECOVERY_TOKEN_HASH_KEY: Type.Optional(
      Type.String({ minLength: ACCOUNT_RECOVERY_TOKEN_HASH_KEY_MIN_LENGTH }),
    ),
    ACCOUNT_RECOVERY_DELIVERY_MODE: Type.Optional(
      Type.Union([Type.Literal('test'), Type.Literal('development'), Type.Literal('resend')]),
    ),
    /**
     * Initial password-setup ceremony gate. Default false / fail-closed.
     * When true, POST /v1/account/password is available under a purpose-bound SetupGrant.
     * Does not enable password sign-in.
     */
    PASSWORD_AUTH_ENABLED: Type.Boolean({ default: false }),
    /**
     * Public password sign-in gate. Default false / fail-closed.
     * When true, POST /v1/authentication/password authenticates existing active accounts.
     * Independent of PASSWORD_AUTH_ENABLED and PASSKEY_AUTHENTICATION_ENABLED.
     * Does not broaden password setup or passkey authentication.
     */
    PASSWORD_SIGN_IN_ENABLED: Type.Boolean({ default: false }),
    /**
     * Session-authenticated password change gate. Default false / fail-closed.
     * When true, POST /v1/account/password/change is available under an active Session.
     * Independent of PASSWORD_AUTH_ENABLED, PASSWORD_SIGN_IN_ENABLED, and PASSKEY_AUTHENTICATION_ENABLED.
     * Does not enable password setup or password sign-in.
     */
    PASSWORD_CHANGE_ENABLED: Type.Boolean({ default: false }),
    /**
     * Reserved for a future peppered hashing slice. Not applied by hashPassword today.
     * Do not invent pepper behavior while this remains unimplemented.
     */
    PASSWORD_HASH_PEPPER: Type.Optional(
      Type.String({ minLength: PASSWORD_HASH_PEPPER_MIN_LENGTH }),
    ),
    LOCAL_ELIGIBILITY_ENABLED: Type.Boolean({ default: false }),
    STRIPE_BILLING_ENABLED: Type.Boolean({ default: false }),
    STRIPE_SECRET_KEY: Type.Optional(Type.String({ minLength: 20 })),
    STRIPE_WEBHOOK_SECRET: Type.Optional(Type.String({ minLength: 20 })),
    STRIPE_ANNUAL_PRICE_ID: Type.Optional(Type.String({ minLength: 6 })),
    STRIPE_PORTAL_CONFIGURATION_ID: Type.Optional(Type.String({ minLength: 4 })),
    STRIPE_CHECKOUT_SUCCESS_URL: Type.Optional(Type.String({ minLength: 8 })),
    STRIPE_CHECKOUT_CANCEL_URL: Type.Optional(Type.String({ minLength: 8 })),
    STRIPE_PORTAL_RETURN_URL: Type.Optional(Type.String({ minLength: 8 })),
    STRIPE_API_VERSION: Type.Optional(Type.Literal('2026-06-24.dahlia')),
    STRIPE_EXPECTED_LIVEMODE: Type.Optional(Type.Boolean()),
    GOOGLE_PLAY_BILLING_ENABLED: Type.Boolean({ default: false }),
    GOOGLE_PLAY_PACKAGE_NAME: Type.Optional(Type.String({ minLength: 3 })),
    GOOGLE_PLAY_SUBSCRIPTION_ID: Type.Optional(Type.String({ minLength: 1 })),
    GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: Type.Optional(Type.String({ minLength: 32 })),
    GOOGLE_PLAY_RTDN_INGRESS_ENABLED: Type.Boolean({ default: false }),
    GOOGLE_PLAY_RTDN_OIDC_AUDIENCE: Type.Optional(Type.String({ minLength: 8 })),
    GOOGLE_PLAY_RTDN_PUSH_SERVICE_ACCOUNT_EMAIL: Type.Optional(
      Type.String({ minLength: 3, maxLength: 320 }),
    ),
    GOOGLE_PLAY_RTDN_PUBSUB_SUBSCRIPTION: Type.Optional(Type.String({ minLength: 1 })),
    OBJECT_STORAGE_ENABLED: Type.Boolean({ default: false }),
    OBJECT_STORAGE_ENDPOINT: Type.Optional(Type.String({ minLength: 1 })),
    OBJECT_STORAGE_BUCKET: Type.Optional(Type.String({ minLength: 1 })),
    OBJECT_STORAGE_ACCESS_KEY_ID: Type.Optional(Type.String({ minLength: 1 })),
    OBJECT_STORAGE_SECRET_ACCESS_KEY: Type.Optional(Type.String({ minLength: 1 })),
    SIGNAL_SUBMISSION_ENABLED: Type.Boolean({ default: false }),
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

/** Minimal email-shape check (local@domain); not full RFC 5322. */
function isEmailAddressShape(value: string): boolean {
  if (value.length < 3 || value.length > 320) {
    return false;
  }
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/** Full Git commit SHA: exactly 40 lowercase hexadecimal characters. No silent normalization. */
export const FULL_GIT_COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

/**
 * Parse an optional commit-SHA env value.
 * Absent / empty → undefined. Present but not a full lowercase 40-char hex SHA → structured error.
 * Does not trim, lowercase, or otherwise normalize invalid or abbreviated values.
 */
export function parseOptionalGitCommitSha(
  raw: string | undefined,
  fieldName: 'RAILWAY_GIT_COMMIT_SHA' | 'APP_COMMIT_SHA',
): string | undefined {
  if (raw === undefined || raw === '') {
    return undefined;
  }
  if (!FULL_GIT_COMMIT_SHA_PATTERN.test(raw)) {
    throw new Error(
      `Invalid environment configuration: ${fieldName} must be a full 40-character lowercase hexadecimal Git commit SHA`,
    );
  }
  return raw;
}

/**
 * Resolve the effective immutable deployment commit SHA.
 * Railway SHA is authoritative when present; otherwise APP_COMMIT_SHA.
 * Call only after both values have been validated and mismatch-checked.
 */
export function resolveEffectiveCommitSha(env: {
  RAILWAY_GIT_COMMIT_SHA?: string;
  APP_COMMIT_SHA?: string;
}): string | undefined {
  return env.RAILWAY_GIT_COMMIT_SHA ?? env.APP_COMMIT_SHA;
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

function resolveAppEnv(
  raw: string | undefined,
  nodeEnv: string,
): 'development' | 'test' | 'staging' | 'production' {
  if (isNonEmptyString(raw)) {
    const normalized = raw.trim().toLowerCase();
    if (
      normalized === 'development' ||
      normalized === 'test' ||
      normalized === 'staging' ||
      normalized === 'production'
    ) {
      return normalized;
    }
    throw new Error(
      'Invalid environment configuration: APP_ENV must be one of development|test|staging|production',
    );
  }
  if (nodeEnv === 'test') {
    return 'test';
  }
  if (nodeEnv === 'production') {
    return 'production';
  }
  return 'development';
}

const KNOWN_CI_HASH_KEY_PLACEHOLDERS = new Set<string>([
  'town-ci-email-verification-hash-key-32b',
  'town-ci-ceremony-rate-limit-hash-key-32b',
  'town-ci-webauthn-challenge-hash-key-32by',
  'town-ci-passkey-auth-challenge-hash-key32',
  'town-ci-session-token-hash-key-32bytesxx',
  'town-ci-account-recovery-hash-key-32byt',
  'town-ci-account-recovery-token-key-32b',
]);

function assertNoLocalDatabaseUrl(url: string): void {
  const lower = url.toLowerCase();
  if (lower.includes('127.0.0.1') || lower.includes('localhost') || lower.includes('town:town@')) {
    throw new Error(
      'Invalid environment configuration: production DATABASE_URL must not use local or default credentials',
    );
  }
}

function sanitizeEnvErrorPath(path: string, message: string): string {
  // Never include raw secret or connection values in error messages.
  if (path.includes('DATABASE_URL')) {
    return `${path}: must be a non-empty connection string`;
  }
  if (path.includes('CONTROLLED_CONFIRMATION_KEY')) {
    return `${path}: must be a non-empty string when controlled confirmation is enabled`;
  }
  if (path.includes('OWNER_SETUP_CODE_EXPECTED') || path.includes('OWNER_SETUP_CODE')) {
    return `${path}: must be exactly 128 characters when provided`;
  }
  if (path.includes('CONTROLLED_TEST_ACTOR_ID')) {
    return `${path}: must be a valid UUID when controlled confirmation is enabled`;
  }
  if (path.includes('EMAIL_VERIFICATION_HASH_KEY')) {
    return `${path}: must meet minimum length when email verification or WebAuthn registration is enabled`;
  }
  if (path.includes('CEREMONY_RATE_LIMIT_HASH_KEY')) {
    return `${path}: must meet minimum length when email verification or WebAuthn registration is enabled`;
  }
  if (path.includes('EMAIL_VERIFICATION_DELIVERY_MODE')) {
    return `${path}: must be test, development, or resend when email verification is enabled`;
  }
  if (path.includes('EMAIL_VERIFICATION_RESEND_API_KEY')) {
    return `${path}: must meet minimum length when Resend delivery is configured`;
  }
  if (path.includes('OBJECT_STORAGE_ACCESS_KEY_ID')) {
    return `${path}: must be a non-empty string when object storage is enabled`;
  }
  if (path.includes('OBJECT_STORAGE_SECRET_ACCESS_KEY')) {
    return `${path}: must be a non-empty string when object storage is enabled`;
  }
  if (
    path.includes('EMAIL_VERIFICATION_FROM_ADDRESS') ||
    path.includes('EMAIL_VERIFICATION_REPLY_TO')
  ) {
    return `${path}: must be a valid email address when Resend delivery is configured`;
  }
  if (path.includes('WEBAUTHN_CHALLENGE_HASH_KEY')) {
    return `${path}: must meet minimum length when WebAuthn registration is enabled`;
  }
  if (path.includes('WEBAUTHN_ALLOWED_ORIGINS')) {
    return `${path}: must be an explicit comma-separated origin allowlist when WebAuthn registration is enabled`;
  }
  if (path.includes('WEBAUTHN_RP_ID')) {
    return `${path}: must be configured when WebAuthn registration or passkey authentication is enabled`;
  }
  if (path.includes('PASSKEY_AUTHENTICATION_CHALLENGE_HASH_KEY')) {
    return `${path}: must meet minimum length when passkey authentication is enabled`;
  }
  if (path.includes('SESSION_TOKEN_HASH_KEY')) {
    return `${path}: must meet minimum length when passkey authentication is enabled`;
  }
  if (path.includes('ACCOUNT_RECOVERY_HASH_KEY')) {
    return `${path}: must meet minimum length when account recovery is enabled`;
  }
  if (path.includes('ACCOUNT_RECOVERY_TOKEN_HASH_KEY')) {
    return `${path}: must meet minimum length when account recovery is enabled`;
  }
  if (path.includes('ACCOUNT_RECOVERY_DELIVERY_MODE')) {
    return `${path}: must be test or development when account recovery is enabled`;
  }
  if (path.includes('STRIPE_SECRET_KEY')) {
    return `${path}: must be a Stripe secret key when Stripe billing is enabled`;
  }
  if (path.includes('STRIPE_WEBHOOK_SECRET')) {
    return `${path}: must be a Stripe webhook secret when Stripe billing is enabled`;
  }
  if (path.includes('STRIPE_ANNUAL_PRICE_ID')) {
    return `${path}: must be a Stripe price id when Stripe billing is enabled`;
  }
  if (path.includes('STRIPE_PORTAL_CONFIGURATION_ID')) {
    return `${path}: must be a Stripe billing portal configuration id when Stripe billing is enabled`;
  }
  if (path.includes('STRIPE_CHECKOUT_SUCCESS_URL')) {
    return `${path}: must be an https URL when Stripe billing is enabled`;
  }
  if (path.includes('STRIPE_CHECKOUT_CANCEL_URL')) {
    return `${path}: must be an https URL when Stripe billing is enabled`;
  }
  if (path.includes('STRIPE_PORTAL_RETURN_URL')) {
    return `${path}: must be an https URL when Stripe billing is enabled`;
  }
  if (path.includes('STRIPE_API_VERSION')) {
    return `${path}: must equal 2026-06-24.dahlia when Stripe billing is enabled`;
  }
  if (path.includes('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON')) {
    return `${path}: must be a valid Google Play service account JSON when Google Play billing is enabled`;
  }
  if (path.includes('GOOGLE_PLAY_PACKAGE_NAME')) {
    return `${path}: must be a non-empty Android package name when Google Play billing is enabled`;
  }
  if (path.includes('GOOGLE_PLAY_SUBSCRIPTION_ID')) {
    return `${path}: must be a non-empty subscription product id when Google Play billing is enabled`;
  }
  if (path.includes('GOOGLE_PLAY_RTDN_OIDC_AUDIENCE')) {
    return `${path}: must be an absolute https URL without wildcard, query, or fragment when Google Play RTDN ingress is enabled`;
  }
  if (path.includes('GOOGLE_PLAY_RTDN_PUSH_SERVICE_ACCOUNT_EMAIL')) {
    return `${path}: must be a valid email address when Google Play RTDN ingress is enabled`;
  }
  if (path.includes('GOOGLE_PLAY_RTDN_PUBSUB_SUBSCRIPTION')) {
    return `${path}: must match projects/{project}/subscriptions/{subscription} when Google Play RTDN ingress is enabled`;
  }
  return `${path}: ${message}`;
}

function isAbsoluteHttpsUrl(value: string, nodeEnv: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') {
    return false;
  }
  if (value.includes('*')) {
    return false;
  }
  if (parsed.hostname.length === 0) {
    return false;
  }
  if (parsed.hostname === 'example.test') {
    // Reserved test hostname.
    return nodeEnv !== 'production';
  }
  return true;
}

function isRtdnAudience(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (
    parsed.protocol === 'https:' &&
    parsed.hostname.length > 0 &&
    !value.includes('*') &&
    parsed.username === '' &&
    parsed.password === '' &&
    parsed.search === '' &&
    parsed.hash === ''
  );
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const controlledEnabled = parseBooleanFlag(
    source.CONTROLLED_CONFIRMATION_ENABLED,
    'CONTROLLED_CONFIRMATION_ENABLED',
  );
  const allowProductionWebOrigin = parseBooleanFlag(
    source.ALLOW_PRODUCTION_WEB_ORIGIN,
    'ALLOW_PRODUCTION_WEB_ORIGIN',
  );
  const emailVerificationEnabled = parseBooleanFlag(
    source.EMAIL_VERIFICATION_ENABLED,
    'EMAIL_VERIFICATION_ENABLED',
  );
  const webauthnRegistrationEnabled = parseBooleanFlag(
    source.WEBAUTHN_REGISTRATION_ENABLED,
    'WEBAUTHN_REGISTRATION_ENABLED',
  );
  const passkeyAuthenticationEnabled = parseBooleanFlag(
    source.PASSKEY_AUTHENTICATION_ENABLED,
    'PASSKEY_AUTHENTICATION_ENABLED',
  );
  const accountRecoveryEnabled = parseBooleanFlag(
    source.ACCOUNT_RECOVERY_ENABLED,
    'ACCOUNT_RECOVERY_ENABLED',
  );
  const passwordAuthEnabled = parseBooleanFlag(
    source.PASSWORD_AUTH_ENABLED,
    'PASSWORD_AUTH_ENABLED',
  );
  const passwordSignInEnabled = parseBooleanFlag(
    source.PASSWORD_SIGN_IN_ENABLED,
    'PASSWORD_SIGN_IN_ENABLED',
  );
  const passwordChangeEnabled = parseBooleanFlag(
    source.PASSWORD_CHANGE_ENABLED,
    'PASSWORD_CHANGE_ENABLED',
  );
  const localEligibilityEnabled = parseBooleanFlag(
    source.LOCAL_ELIGIBILITY_ENABLED,
    'LOCAL_ELIGIBILITY_ENABLED',
  );
  const trustProxy = parseBooleanFlag(source.TRUST_PROXY, 'TRUST_PROXY');
  const objectStorageEnabled = parseBooleanFlag(
    source.OBJECT_STORAGE_ENABLED,
    'OBJECT_STORAGE_ENABLED',
  );
  const signalSubmissionEnabled = parseBooleanFlag(
    source.SIGNAL_SUBMISSION_ENABLED,
    'SIGNAL_SUBMISSION_ENABLED',
  );
  const stripeBillingEnabled = parseBooleanFlag(
    source.STRIPE_BILLING_ENABLED,
    'STRIPE_BILLING_ENABLED',
  );
  const googlePlayBillingEnabled = parseBooleanFlag(
    source.GOOGLE_PLAY_BILLING_ENABLED,
    'GOOGLE_PLAY_BILLING_ENABLED',
  );
  const googlePlayRtdnIngressEnabled = parseBooleanFlag(
    source.GOOGLE_PLAY_RTDN_INGRESS_ENABLED,
    'GOOGLE_PLAY_RTDN_INGRESS_ENABLED',
  );
  const nodeEnv = source.NODE_ENV ?? 'development';
  const appEnv = resolveAppEnv(source.APP_ENV, nodeEnv);
  // Production policy is APP_ENV-only. NODE_ENV=production is normal on Railway
  // staging containers and must not force production Stripe/WebAuthn/email rules.
  const runtimeIsProduction = appEnv === 'production';
  const runtimeIsStaging = appEnv === 'staging';
  const railwayCommitSha = parseOptionalGitCommitSha(
    source.RAILWAY_GIT_COMMIT_SHA,
    'RAILWAY_GIT_COMMIT_SHA',
  );
  const appCommitSha = parseOptionalGitCommitSha(source.APP_COMMIT_SHA, 'APP_COMMIT_SHA');
  if (
    railwayCommitSha !== undefined &&
    appCommitSha !== undefined &&
    railwayCommitSha !== appCommitSha
  ) {
    throw new Error(
      'Invalid environment configuration: RAILWAY_GIT_COMMIT_SHA and APP_COMMIT_SHA must match exactly when both are set',
    );
  }
  const buildTimestampRaw = source.APP_BUILD_TIMESTAMP;
  const buildTimestamp = isNonEmptyString(buildTimestampRaw) ? buildTimestampRaw.trim() : undefined;

  const candidate: Record<string, unknown> = {
    NODE_ENV: nodeEnv,
    APP_ENV: appEnv,
    ...(appCommitSha !== undefined ? { APP_COMMIT_SHA: appCommitSha } : {}),
    ...(railwayCommitSha !== undefined ? { RAILWAY_GIT_COMMIT_SHA: railwayCommitSha } : {}),
    ...(buildTimestamp !== undefined ? { APP_BUILD_TIMESTAMP: buildTimestamp } : {}),
    READINESS_TIMEOUT_MS:
      source.READINESS_TIMEOUT_MS === undefined ? 3_000 : parseInteger(source.READINESS_TIMEOUT_MS),
    GRACEFUL_SHUTDOWN_TIMEOUT_MS:
      source.GRACEFUL_SHUTDOWN_TIMEOUT_MS === undefined
        ? 10_000
        : parseInteger(source.GRACEFUL_SHUTDOWN_TIMEOUT_MS),
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
    DATABASE_BACKUP_PROVIDER: (() => {
      const raw = source.DATABASE_BACKUP_PROVIDER;
      if (raw === undefined || raw === '') return 'none';
      const normalized = raw.trim().toLowerCase();
      if (normalized === 'none' || normalized === 'railway_postgres_pitr') return normalized;
      throw new Error(
        'Invalid environment configuration: DATABASE_BACKUP_PROVIDER must be none or railway_postgres_pitr',
      );
    })(),
    DATABASE_BACKUP_PITR_ENABLED: parseBooleanFlag(
      source.DATABASE_BACKUP_PITR_ENABLED,
      'DATABASE_BACKUP_PITR_ENABLED',
    ),
    ...(source.DATABASE_BACKUP_RETENTION_DAYS !== undefined &&
    source.DATABASE_BACKUP_RETENTION_DAYS !== ''
      ? {
          DATABASE_BACKUP_RETENTION_DAYS: parseInteger(source.DATABASE_BACKUP_RETENTION_DAYS),
        }
      : {}),
    DATABASE_BACKUP_VERIFY_MAX_AGE_DAYS:
      source.DATABASE_BACKUP_VERIFY_MAX_AGE_DAYS === undefined ||
      source.DATABASE_BACKUP_VERIFY_MAX_AGE_DAYS === ''
        ? 30
        : parseInteger(source.DATABASE_BACKUP_VERIFY_MAX_AGE_DAYS),
    DATABASE_RESTORE_DRILL_MAX_AGE_DAYS:
      source.DATABASE_RESTORE_DRILL_MAX_AGE_DAYS === undefined ||
      source.DATABASE_RESTORE_DRILL_MAX_AGE_DAYS === ''
        ? 90
        : parseInteger(source.DATABASE_RESTORE_DRILL_MAX_AGE_DAYS),
    CONTROLLED_CONFIRMATION_ENABLED: controlledEnabled,
    ALLOW_PRODUCTION_WEB_ORIGIN: allowProductionWebOrigin,
    EMAIL_VERIFICATION_ENABLED: emailVerificationEnabled,
    WEBAUTHN_REGISTRATION_ENABLED: webauthnRegistrationEnabled,
    PASSKEY_AUTHENTICATION_ENABLED: passkeyAuthenticationEnabled,
    ACCOUNT_RECOVERY_ENABLED: accountRecoveryEnabled,
    PASSWORD_AUTH_ENABLED: passwordAuthEnabled,
    PASSWORD_SIGN_IN_ENABLED: passwordSignInEnabled,
    PASSWORD_CHANGE_ENABLED: passwordChangeEnabled,
    LOCAL_ELIGIBILITY_ENABLED: localEligibilityEnabled,
    STRIPE_BILLING_ENABLED: stripeBillingEnabled,
    GOOGLE_PLAY_BILLING_ENABLED: googlePlayBillingEnabled,
    GOOGLE_PLAY_RTDN_INGRESS_ENABLED: googlePlayRtdnIngressEnabled,
    OBJECT_STORAGE_ENABLED: objectStorageEnabled,
    SIGNAL_SUBMISSION_ENABLED: signalSubmissionEnabled,
    TRUST_PROXY: trustProxy,
  };

  if (objectStorageEnabled) {
    if (!isNonEmptyString(source.OBJECT_STORAGE_ENDPOINT)) {
      throw new Error(
        'Invalid environment configuration: OBJECT_STORAGE_ENDPOINT is required when OBJECT_STORAGE_ENABLED is true',
      );
    }
    if (!isNonEmptyString(source.OBJECT_STORAGE_BUCKET)) {
      throw new Error(
        'Invalid environment configuration: OBJECT_STORAGE_BUCKET is required when OBJECT_STORAGE_ENABLED is true',
      );
    }
    if (!isNonEmptyString(source.OBJECT_STORAGE_ACCESS_KEY_ID)) {
      throw new Error(
        'Invalid environment configuration: OBJECT_STORAGE_ACCESS_KEY_ID is required when OBJECT_STORAGE_ENABLED is true',
      );
    }
    if (!isNonEmptyString(source.OBJECT_STORAGE_SECRET_ACCESS_KEY)) {
      throw new Error(
        'Invalid environment configuration: OBJECT_STORAGE_SECRET_ACCESS_KEY is required when OBJECT_STORAGE_ENABLED is true',
      );
    }
    candidate.OBJECT_STORAGE_ENDPOINT = source.OBJECT_STORAGE_ENDPOINT;
    candidate.OBJECT_STORAGE_BUCKET = source.OBJECT_STORAGE_BUCKET;
    candidate.OBJECT_STORAGE_ACCESS_KEY_ID = source.OBJECT_STORAGE_ACCESS_KEY_ID;
    candidate.OBJECT_STORAGE_SECRET_ACCESS_KEY = source.OBJECT_STORAGE_SECRET_ACCESS_KEY;
  }

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
    if (deliveryMode !== 'test' && deliveryMode !== 'development' && deliveryMode !== 'resend') {
      throw new Error(
        'Invalid environment configuration: EMAIL_VERIFICATION_DELIVERY_MODE must be test, development, or resend when EMAIL_VERIFICATION_ENABLED is true',
      );
    }
    if (appEnv === 'production' && deliveryMode !== 'resend') {
      throw new Error(
        'Invalid environment configuration: EMAIL_VERIFICATION_ENABLED in production requires EMAIL_VERIFICATION_DELIVERY_MODE=resend',
      );
    }
    if (deliveryMode === 'resend') {
      if (
        !isNonEmptyString(source.EMAIL_VERIFICATION_RESEND_API_KEY) ||
        source.EMAIL_VERIFICATION_RESEND_API_KEY.length < 20
      ) {
        throw new Error(
          'Invalid environment configuration: EMAIL_VERIFICATION_RESEND_API_KEY is required (min length 20) when EMAIL_VERIFICATION_DELIVERY_MODE is resend',
        );
      }
      if (
        !isNonEmptyString(source.EMAIL_VERIFICATION_FROM_ADDRESS) ||
        !isEmailAddressShape(source.EMAIL_VERIFICATION_FROM_ADDRESS)
      ) {
        throw new Error(
          'Invalid environment configuration: EMAIL_VERIFICATION_FROM_ADDRESS must be a valid email address when EMAIL_VERIFICATION_DELIVERY_MODE is resend',
        );
      }
      if (
        source.EMAIL_VERIFICATION_REPLY_TO !== undefined &&
        source.EMAIL_VERIFICATION_REPLY_TO !== '' &&
        !isEmailAddressShape(source.EMAIL_VERIFICATION_REPLY_TO)
      ) {
        throw new Error(
          'Invalid environment configuration: EMAIL_VERIFICATION_REPLY_TO must be a valid email address when set',
        );
      }
      candidate.EMAIL_VERIFICATION_RESEND_API_KEY = source.EMAIL_VERIFICATION_RESEND_API_KEY;
      candidate.EMAIL_VERIFICATION_FROM_ADDRESS = source.EMAIL_VERIFICATION_FROM_ADDRESS;
      if (isNonEmptyString(source.EMAIL_VERIFICATION_REPLY_TO)) {
        candidate.EMAIL_VERIFICATION_REPLY_TO = source.EMAIL_VERIFICATION_REPLY_TO;
      }
    }
    candidate.EMAIL_VERIFICATION_HASH_KEY = source.EMAIL_VERIFICATION_HASH_KEY;
    candidate.CEREMONY_RATE_LIMIT_HASH_KEY = source.CEREMONY_RATE_LIMIT_HASH_KEY;
    candidate.EMAIL_VERIFICATION_DELIVERY_MODE = deliveryMode;
  }

  if (webauthnRegistrationEnabled) {
    if (!isNonEmptyString(source.WEBAUTHN_RP_ID)) {
      throw new Error(
        'Invalid environment configuration: WEBAUTHN_RP_ID is required when WEBAUTHN_REGISTRATION_ENABLED is true',
      );
    }
    if (source.WEBAUTHN_RP_ID.includes('*')) {
      throw new Error(
        'Invalid environment configuration: WEBAUTHN_RP_ID must not contain wildcards',
      );
    }
    const rpName =
      isNonEmptyString(source.WEBAUTHN_RP_NAME) && source.WEBAUTHN_RP_NAME.trim().length > 0
        ? source.WEBAUTHN_RP_NAME.trim()
        : DEFAULT_WEBAUTHN_RP_NAME;
    if (!isNonEmptyString(source.WEBAUTHN_ALLOWED_ORIGINS)) {
      throw new Error(
        'Invalid environment configuration: WEBAUTHN_ALLOWED_ORIGINS is required when WEBAUTHN_REGISTRATION_ENABLED is true',
      );
    }
    if (!isNonEmptyString(source.WEBAUTHN_CHALLENGE_HASH_KEY)) {
      throw new Error(
        'Invalid environment configuration: WEBAUTHN_CHALLENGE_HASH_KEY is required when WEBAUTHN_REGISTRATION_ENABLED is true',
      );
    }
    if (source.WEBAUTHN_CHALLENGE_HASH_KEY.length < WEBAUTHN_CHALLENGE_HASH_KEY_MIN_LENGTH) {
      throw new Error(
        `Invalid environment configuration: WEBAUTHN_CHALLENGE_HASH_KEY must be at least ${String(WEBAUTHN_CHALLENGE_HASH_KEY_MIN_LENGTH)} characters`,
      );
    }
    // Setup-grant token hashing must match Slice 2 issuance (EMAIL_VERIFICATION_HASH_KEY).
    if (!isNonEmptyString(source.EMAIL_VERIFICATION_HASH_KEY)) {
      throw new Error(
        'Invalid environment configuration: EMAIL_VERIFICATION_HASH_KEY is required when WEBAUTHN_REGISTRATION_ENABLED is true',
      );
    }
    if (source.EMAIL_VERIFICATION_HASH_KEY.length < EMAIL_VERIFICATION_HASH_KEY_MIN_LENGTH) {
      throw new Error(
        `Invalid environment configuration: EMAIL_VERIFICATION_HASH_KEY must be at least ${String(EMAIL_VERIFICATION_HASH_KEY_MIN_LENGTH)} characters`,
      );
    }
    if (!isNonEmptyString(source.CEREMONY_RATE_LIMIT_HASH_KEY)) {
      throw new Error(
        'Invalid environment configuration: CEREMONY_RATE_LIMIT_HASH_KEY is required when WEBAUTHN_REGISTRATION_ENABLED is true',
      );
    }
    if (source.CEREMONY_RATE_LIMIT_HASH_KEY.length < CEREMONY_RATE_LIMIT_HASH_KEY_MIN_LENGTH) {
      throw new Error(
        `Invalid environment configuration: CEREMONY_RATE_LIMIT_HASH_KEY must be at least ${String(CEREMONY_RATE_LIMIT_HASH_KEY_MIN_LENGTH)} characters`,
      );
    }

    const allowedOrigins = parseAllowedOrigins(source.WEBAUTHN_ALLOWED_ORIGINS, {
      nodeEnv,
      appEnv,
    });
    if (appEnv === 'production') {
      assertProductionWebAuthnPolicy(source.WEBAUTHN_RP_ID, allowedOrigins);
      if (source.WEBAUTHN_RP_ID === 'localhost') {
        throw new Error(
          'Invalid environment configuration: production WEBAUTHN_RP_ID cannot be localhost',
        );
      }
    }

    candidate.WEBAUTHN_RP_ID = source.WEBAUTHN_RP_ID;
    candidate.WEBAUTHN_RP_NAME = rpName;
    candidate.WEBAUTHN_ALLOWED_ORIGINS = source.WEBAUTHN_ALLOWED_ORIGINS;
    candidate.WEBAUTHN_CHALLENGE_HASH_KEY = source.WEBAUTHN_CHALLENGE_HASH_KEY;
    candidate.EMAIL_VERIFICATION_HASH_KEY = source.EMAIL_VERIFICATION_HASH_KEY;
    candidate.CEREMONY_RATE_LIMIT_HASH_KEY = source.CEREMONY_RATE_LIMIT_HASH_KEY;
  }

  if (passkeyAuthenticationEnabled) {
    if (!isNonEmptyString(source.WEBAUTHN_RP_ID)) {
      throw new Error(
        'Invalid environment configuration: WEBAUTHN_RP_ID is required when PASSKEY_AUTHENTICATION_ENABLED is true',
      );
    }
    if (source.WEBAUTHN_RP_ID.includes('*')) {
      throw new Error(
        'Invalid environment configuration: WEBAUTHN_RP_ID must not contain wildcards',
      );
    }
    const rpName =
      isNonEmptyString(source.WEBAUTHN_RP_NAME) && source.WEBAUTHN_RP_NAME.trim().length > 0
        ? source.WEBAUTHN_RP_NAME.trim()
        : DEFAULT_WEBAUTHN_RP_NAME;
    if (!isNonEmptyString(source.WEBAUTHN_ALLOWED_ORIGINS)) {
      throw new Error(
        'Invalid environment configuration: WEBAUTHN_ALLOWED_ORIGINS is required when PASSKEY_AUTHENTICATION_ENABLED is true',
      );
    }
    if (!isNonEmptyString(source.PASSKEY_AUTHENTICATION_CHALLENGE_HASH_KEY)) {
      throw new Error(
        'Invalid environment configuration: PASSKEY_AUTHENTICATION_CHALLENGE_HASH_KEY is required when PASSKEY_AUTHENTICATION_ENABLED is true',
      );
    }
    if (
      source.PASSKEY_AUTHENTICATION_CHALLENGE_HASH_KEY.length <
      PASSKEY_AUTHENTICATION_CHALLENGE_HASH_KEY_MIN_LENGTH
    ) {
      throw new Error(
        `Invalid environment configuration: PASSKEY_AUTHENTICATION_CHALLENGE_HASH_KEY must be at least ${String(PASSKEY_AUTHENTICATION_CHALLENGE_HASH_KEY_MIN_LENGTH)} characters`,
      );
    }
    if (!isNonEmptyString(source.SESSION_TOKEN_HASH_KEY)) {
      throw new Error(
        'Invalid environment configuration: SESSION_TOKEN_HASH_KEY is required when PASSKEY_AUTHENTICATION_ENABLED is true',
      );
    }
    if (source.SESSION_TOKEN_HASH_KEY.length < SESSION_TOKEN_HASH_KEY_MIN_LENGTH) {
      throw new Error(
        `Invalid environment configuration: SESSION_TOKEN_HASH_KEY must be at least ${String(SESSION_TOKEN_HASH_KEY_MIN_LENGTH)} characters`,
      );
    }
    if (!isNonEmptyString(source.CEREMONY_RATE_LIMIT_HASH_KEY)) {
      throw new Error(
        'Invalid environment configuration: CEREMONY_RATE_LIMIT_HASH_KEY is required when PASSKEY_AUTHENTICATION_ENABLED is true',
      );
    }
    if (source.CEREMONY_RATE_LIMIT_HASH_KEY.length < CEREMONY_RATE_LIMIT_HASH_KEY_MIN_LENGTH) {
      throw new Error(
        `Invalid environment configuration: CEREMONY_RATE_LIMIT_HASH_KEY must be at least ${String(CEREMONY_RATE_LIMIT_HASH_KEY_MIN_LENGTH)} characters`,
      );
    }

    const allowedOrigins = parseAllowedOrigins(source.WEBAUTHN_ALLOWED_ORIGINS, {
      nodeEnv,
      appEnv,
    });
    if (appEnv === 'production') {
      assertProductionWebAuthnPolicy(source.WEBAUTHN_RP_ID, allowedOrigins);
      if (source.WEBAUTHN_RP_ID === 'localhost') {
        throw new Error(
          'Invalid environment configuration: production WEBAUTHN_RP_ID cannot be localhost',
        );
      }
    }

    const cookieName = isNonEmptyString(source.WEB_SESSION_COOKIE_NAME)
      ? source.WEB_SESSION_COOKIE_NAME
      : DEFAULT_WEB_SESSION_COOKIE_NAME;

    candidate.WEBAUTHN_RP_ID = source.WEBAUTHN_RP_ID;
    candidate.WEBAUTHN_RP_NAME = rpName;
    candidate.WEBAUTHN_ALLOWED_ORIGINS = source.WEBAUTHN_ALLOWED_ORIGINS;
    candidate.PASSKEY_AUTHENTICATION_CHALLENGE_HASH_KEY =
      source.PASSKEY_AUTHENTICATION_CHALLENGE_HASH_KEY;
    candidate.SESSION_TOKEN_HASH_KEY = source.SESSION_TOKEN_HASH_KEY;
    candidate.CEREMONY_RATE_LIMIT_HASH_KEY = source.CEREMONY_RATE_LIMIT_HASH_KEY;
    candidate.WEB_SESSION_COOKIE_NAME = cookieName;
  }

  if (passwordSignInEnabled) {
    if (!isNonEmptyString(source.SESSION_TOKEN_HASH_KEY)) {
      throw new Error(
        'Invalid environment configuration: SESSION_TOKEN_HASH_KEY is required when PASSWORD_SIGN_IN_ENABLED is true',
      );
    }
    if (source.SESSION_TOKEN_HASH_KEY.length < SESSION_TOKEN_HASH_KEY_MIN_LENGTH) {
      throw new Error(
        `Invalid environment configuration: SESSION_TOKEN_HASH_KEY must be at least ${String(SESSION_TOKEN_HASH_KEY_MIN_LENGTH)} characters`,
      );
    }
    if (!isNonEmptyString(source.CEREMONY_RATE_LIMIT_HASH_KEY)) {
      throw new Error(
        'Invalid environment configuration: CEREMONY_RATE_LIMIT_HASH_KEY is required when PASSWORD_SIGN_IN_ENABLED is true',
      );
    }
    if (source.CEREMONY_RATE_LIMIT_HASH_KEY.length < CEREMONY_RATE_LIMIT_HASH_KEY_MIN_LENGTH) {
      throw new Error(
        `Invalid environment configuration: CEREMONY_RATE_LIMIT_HASH_KEY must be at least ${String(CEREMONY_RATE_LIMIT_HASH_KEY_MIN_LENGTH)} characters`,
      );
    }
    if (!isNonEmptyString(source.WEBAUTHN_ALLOWED_ORIGINS)) {
      throw new Error(
        'Invalid environment configuration: WEBAUTHN_ALLOWED_ORIGINS is required when PASSWORD_SIGN_IN_ENABLED is true (shared web session CSRF)',
      );
    }
    // Validate origin vocabulary using the shared parser; does not enable passkey auth.
    parseAllowedOrigins(source.WEBAUTHN_ALLOWED_ORIGINS, {
      nodeEnv,
      appEnv,
    });

    const cookieName = isNonEmptyString(source.WEB_SESSION_COOKIE_NAME)
      ? source.WEB_SESSION_COOKIE_NAME
      : DEFAULT_WEB_SESSION_COOKIE_NAME;

    candidate.SESSION_TOKEN_HASH_KEY = source.SESSION_TOKEN_HASH_KEY;
    candidate.CEREMONY_RATE_LIMIT_HASH_KEY = source.CEREMONY_RATE_LIMIT_HASH_KEY;
    candidate.WEB_SESSION_COOKIE_NAME = cookieName;
    candidate.WEBAUTHN_ALLOWED_ORIGINS = source.WEBAUTHN_ALLOWED_ORIGINS;
  }

  if (passwordChangeEnabled) {
    if (!isNonEmptyString(source.SESSION_TOKEN_HASH_KEY)) {
      throw new Error(
        'Invalid environment configuration: SESSION_TOKEN_HASH_KEY is required when PASSWORD_CHANGE_ENABLED is true',
      );
    }
    if (source.SESSION_TOKEN_HASH_KEY.length < SESSION_TOKEN_HASH_KEY_MIN_LENGTH) {
      throw new Error(
        `Invalid environment configuration: SESSION_TOKEN_HASH_KEY must be at least ${String(SESSION_TOKEN_HASH_KEY_MIN_LENGTH)} characters`,
      );
    }
    if (!isNonEmptyString(source.CEREMONY_RATE_LIMIT_HASH_KEY)) {
      throw new Error(
        'Invalid environment configuration: CEREMONY_RATE_LIMIT_HASH_KEY is required when PASSWORD_CHANGE_ENABLED is true',
      );
    }
    if (source.CEREMONY_RATE_LIMIT_HASH_KEY.length < CEREMONY_RATE_LIMIT_HASH_KEY_MIN_LENGTH) {
      throw new Error(
        `Invalid environment configuration: CEREMONY_RATE_LIMIT_HASH_KEY must be at least ${String(CEREMONY_RATE_LIMIT_HASH_KEY_MIN_LENGTH)} characters`,
      );
    }
    if (!isNonEmptyString(source.WEBAUTHN_ALLOWED_ORIGINS)) {
      throw new Error(
        'Invalid environment configuration: WEBAUTHN_ALLOWED_ORIGINS is required when PASSWORD_CHANGE_ENABLED is true (shared web session CSRF)',
      );
    }
    parseAllowedOrigins(source.WEBAUTHN_ALLOWED_ORIGINS, {
      nodeEnv,
      appEnv,
    });

    const cookieName = isNonEmptyString(source.WEB_SESSION_COOKIE_NAME)
      ? source.WEB_SESSION_COOKIE_NAME
      : DEFAULT_WEB_SESSION_COOKIE_NAME;

    candidate.SESSION_TOKEN_HASH_KEY = source.SESSION_TOKEN_HASH_KEY;
    candidate.CEREMONY_RATE_LIMIT_HASH_KEY = source.CEREMONY_RATE_LIMIT_HASH_KEY;
    candidate.WEB_SESSION_COOKIE_NAME = cookieName;
    candidate.WEBAUTHN_ALLOWED_ORIGINS = source.WEBAUTHN_ALLOWED_ORIGINS;
  }

  if (accountRecoveryEnabled) {
    if (!isNonEmptyString(source.ACCOUNT_RECOVERY_HASH_KEY)) {
      throw new Error(
        'Invalid environment configuration: ACCOUNT_RECOVERY_HASH_KEY is required when ACCOUNT_RECOVERY_ENABLED is true',
      );
    }
    if (source.ACCOUNT_RECOVERY_HASH_KEY.length < ACCOUNT_RECOVERY_HASH_KEY_MIN_LENGTH) {
      throw new Error(
        `Invalid environment configuration: ACCOUNT_RECOVERY_HASH_KEY must be at least ${String(ACCOUNT_RECOVERY_HASH_KEY_MIN_LENGTH)} characters`,
      );
    }
    if (!isNonEmptyString(source.ACCOUNT_RECOVERY_TOKEN_HASH_KEY)) {
      throw new Error(
        'Invalid environment configuration: ACCOUNT_RECOVERY_TOKEN_HASH_KEY is required when ACCOUNT_RECOVERY_ENABLED is true',
      );
    }
    if (
      source.ACCOUNT_RECOVERY_TOKEN_HASH_KEY.length < ACCOUNT_RECOVERY_TOKEN_HASH_KEY_MIN_LENGTH
    ) {
      throw new Error(
        `Invalid environment configuration: ACCOUNT_RECOVERY_TOKEN_HASH_KEY must be at least ${String(ACCOUNT_RECOVERY_TOKEN_HASH_KEY_MIN_LENGTH)} characters`,
      );
    }
    const deliveryMode = source.ACCOUNT_RECOVERY_DELIVERY_MODE;
    if (deliveryMode !== 'test' && deliveryMode !== 'development' && deliveryMode !== 'resend') {
      throw new Error(
        'Invalid environment configuration: ACCOUNT_RECOVERY_DELIVERY_MODE must be test, development, or resend when ACCOUNT_RECOVERY_ENABLED is true',
      );
    }
    if (appEnv === 'production' && deliveryMode !== 'resend') {
      throw new Error(
        'Invalid environment configuration: ACCOUNT_RECOVERY_ENABLED in production requires ACCOUNT_RECOVERY_DELIVERY_MODE=resend',
      );
    }
    if (deliveryMode === 'resend') {
      // Reuse the shared Resend credentials used by email verification (same provider account).
      if (
        !isNonEmptyString(source.EMAIL_VERIFICATION_RESEND_API_KEY) ||
        source.EMAIL_VERIFICATION_RESEND_API_KEY.length < 20
      ) {
        throw new Error(
          'Invalid environment configuration: EMAIL_VERIFICATION_RESEND_API_KEY is required (min length 20) when ACCOUNT_RECOVERY_DELIVERY_MODE is resend',
        );
      }
      if (
        !isNonEmptyString(source.EMAIL_VERIFICATION_FROM_ADDRESS) ||
        !isEmailAddressShape(source.EMAIL_VERIFICATION_FROM_ADDRESS)
      ) {
        throw new Error(
          'Invalid environment configuration: EMAIL_VERIFICATION_FROM_ADDRESS must be a valid email address when ACCOUNT_RECOVERY_DELIVERY_MODE is resend',
        );
      }
      if (
        source.EMAIL_VERIFICATION_REPLY_TO !== undefined &&
        source.EMAIL_VERIFICATION_REPLY_TO !== '' &&
        !isEmailAddressShape(source.EMAIL_VERIFICATION_REPLY_TO)
      ) {
        throw new Error(
          'Invalid environment configuration: EMAIL_VERIFICATION_REPLY_TO must be a valid email address when set',
        );
      }
      candidate.EMAIL_VERIFICATION_RESEND_API_KEY = source.EMAIL_VERIFICATION_RESEND_API_KEY;
      candidate.EMAIL_VERIFICATION_FROM_ADDRESS = source.EMAIL_VERIFICATION_FROM_ADDRESS;
      if (isNonEmptyString(source.EMAIL_VERIFICATION_REPLY_TO)) {
        candidate.EMAIL_VERIFICATION_REPLY_TO = source.EMAIL_VERIFICATION_REPLY_TO;
      }
    }
    if (!isNonEmptyString(source.CEREMONY_RATE_LIMIT_HASH_KEY)) {
      throw new Error(
        'Invalid environment configuration: CEREMONY_RATE_LIMIT_HASH_KEY is required when ACCOUNT_RECOVERY_ENABLED is true',
      );
    }
    if (source.CEREMONY_RATE_LIMIT_HASH_KEY.length < CEREMONY_RATE_LIMIT_HASH_KEY_MIN_LENGTH) {
      throw new Error(
        `Invalid environment configuration: CEREMONY_RATE_LIMIT_HASH_KEY must be at least ${String(CEREMONY_RATE_LIMIT_HASH_KEY_MIN_LENGTH)} characters`,
      );
    }
    if (!isNonEmptyString(source.WEBAUTHN_RP_ID)) {
      throw new Error(
        'Invalid environment configuration: WEBAUTHN_RP_ID is required when ACCOUNT_RECOVERY_ENABLED is true',
      );
    }
    if (source.WEBAUTHN_RP_ID.includes('*')) {
      throw new Error(
        'Invalid environment configuration: WEBAUTHN_RP_ID must not contain wildcards',
      );
    }
    const rpName =
      isNonEmptyString(source.WEBAUTHN_RP_NAME) && source.WEBAUTHN_RP_NAME.trim().length > 0
        ? source.WEBAUTHN_RP_NAME.trim()
        : DEFAULT_WEBAUTHN_RP_NAME;
    if (!isNonEmptyString(source.WEBAUTHN_ALLOWED_ORIGINS)) {
      throw new Error(
        'Invalid environment configuration: WEBAUTHN_ALLOWED_ORIGINS is required when ACCOUNT_RECOVERY_ENABLED is true',
      );
    }
    if (!isNonEmptyString(source.WEBAUTHN_CHALLENGE_HASH_KEY)) {
      throw new Error(
        'Invalid environment configuration: WEBAUTHN_CHALLENGE_HASH_KEY is required when ACCOUNT_RECOVERY_ENABLED is true',
      );
    }
    if (source.WEBAUTHN_CHALLENGE_HASH_KEY.length < WEBAUTHN_CHALLENGE_HASH_KEY_MIN_LENGTH) {
      throw new Error(
        `Invalid environment configuration: WEBAUTHN_CHALLENGE_HASH_KEY must be at least ${String(WEBAUTHN_CHALLENGE_HASH_KEY_MIN_LENGTH)} characters`,
      );
    }

    const allowedOrigins = parseAllowedOrigins(source.WEBAUTHN_ALLOWED_ORIGINS, {
      nodeEnv,
      appEnv,
    });
    if (appEnv === 'production') {
      assertProductionWebAuthnPolicy(source.WEBAUTHN_RP_ID, allowedOrigins);
      if (source.WEBAUTHN_RP_ID === 'localhost') {
        throw new Error(
          'Invalid environment configuration: production WEBAUTHN_RP_ID cannot be localhost',
        );
      }
    }

    candidate.ACCOUNT_RECOVERY_HASH_KEY = source.ACCOUNT_RECOVERY_HASH_KEY;
    candidate.ACCOUNT_RECOVERY_TOKEN_HASH_KEY = source.ACCOUNT_RECOVERY_TOKEN_HASH_KEY;
    candidate.ACCOUNT_RECOVERY_DELIVERY_MODE = deliveryMode;
    candidate.CEREMONY_RATE_LIMIT_HASH_KEY = source.CEREMONY_RATE_LIMIT_HASH_KEY;
    candidate.WEBAUTHN_RP_ID = source.WEBAUTHN_RP_ID;
    candidate.WEBAUTHN_RP_NAME = rpName;
    candidate.WEBAUTHN_ALLOWED_ORIGINS = source.WEBAUTHN_ALLOWED_ORIGINS;
    candidate.WEBAUTHN_CHALLENGE_HASH_KEY = source.WEBAUTHN_CHALLENGE_HASH_KEY;
  }

  if (stripeBillingEnabled) {
    const secretKey = source.STRIPE_SECRET_KEY;
    const webhookSecret = source.STRIPE_WEBHOOK_SECRET;
    const priceId = source.STRIPE_ANNUAL_PRICE_ID;
    const portalConfigId = source.STRIPE_PORTAL_CONFIGURATION_ID;
    const checkoutSuccessUrl = source.STRIPE_CHECKOUT_SUCCESS_URL;
    const checkoutCancelUrl = source.STRIPE_CHECKOUT_CANCEL_URL;
    const portalReturnUrl = source.STRIPE_PORTAL_RETURN_URL;
    const apiVersion = source.STRIPE_API_VERSION;
    const expectedLivemodeRaw = source.STRIPE_EXPECTED_LIVEMODE;

    if (!isNonEmptyString(secretKey) || secretKey.length < 20 || !secretKey.startsWith('sk_')) {
      throw new Error(
        'Invalid environment configuration: STRIPE_SECRET_KEY must be a Stripe secret key (starts with sk_, min length 20) when STRIPE_BILLING_ENABLED is true',
      );
    }
    if (
      !isNonEmptyString(webhookSecret) ||
      webhookSecret.length < 20 ||
      !webhookSecret.startsWith('whsec_')
    ) {
      throw new Error(
        'Invalid environment configuration: STRIPE_WEBHOOK_SECRET must be a Stripe webhook secret (starts with whsec_, min length 20) when STRIPE_BILLING_ENABLED is true',
      );
    }
    if (!isNonEmptyString(priceId) || !priceId.startsWith('price_')) {
      throw new Error(
        'Invalid environment configuration: STRIPE_ANNUAL_PRICE_ID must start with price_ when STRIPE_BILLING_ENABLED is true',
      );
    }
    if (!isNonEmptyString(portalConfigId) || !portalConfigId.startsWith('bpc_')) {
      throw new Error(
        'Invalid environment configuration: STRIPE_PORTAL_CONFIGURATION_ID must start with bpc_ when STRIPE_BILLING_ENABLED is true',
      );
    }
    for (const [name, url] of [
      ['STRIPE_CHECKOUT_SUCCESS_URL', checkoutSuccessUrl],
      ['STRIPE_CHECKOUT_CANCEL_URL', checkoutCancelUrl],
      ['STRIPE_PORTAL_RETURN_URL', portalReturnUrl],
    ] as const) {
      if (!isNonEmptyString(url) || !isAbsoluteHttpsUrl(url, nodeEnv)) {
        throw new Error(
          `Invalid environment configuration: ${name} must be an absolute https URL when STRIPE_BILLING_ENABLED is true`,
        );
      }
    }
    if (apiVersion !== undefined && apiVersion !== STRIPE_API_VERSION) {
      throw new Error(
        `Invalid environment configuration: STRIPE_API_VERSION must equal ${STRIPE_API_VERSION} when STRIPE_BILLING_ENABLED is true`,
      );
    }

    let expectedLivemode: boolean;
    if (expectedLivemodeRaw === undefined || expectedLivemodeRaw === '') {
      expectedLivemode = runtimeIsProduction;
    } else {
      expectedLivemode = parseBooleanFlag(expectedLivemodeRaw, 'STRIPE_EXPECTED_LIVEMODE');
    }
    if (runtimeIsProduction && !expectedLivemode) {
      throw new Error(
        'Invalid environment configuration: STRIPE_EXPECTED_LIVEMODE must be true in production',
      );
    }
    if (!runtimeIsProduction && expectedLivemode) {
      throw new Error(
        'Invalid environment configuration: STRIPE_EXPECTED_LIVEMODE must be false outside production',
      );
    }

    if (!isNonEmptyString(source.CEREMONY_RATE_LIMIT_HASH_KEY)) {
      throw new Error(
        'Invalid environment configuration: CEREMONY_RATE_LIMIT_HASH_KEY is required when STRIPE_BILLING_ENABLED is true',
      );
    }
    if (source.CEREMONY_RATE_LIMIT_HASH_KEY.length < CEREMONY_RATE_LIMIT_HASH_KEY_MIN_LENGTH) {
      throw new Error(
        `Invalid environment configuration: CEREMONY_RATE_LIMIT_HASH_KEY must be at least ${String(CEREMONY_RATE_LIMIT_HASH_KEY_MIN_LENGTH)} characters when STRIPE_BILLING_ENABLED is true`,
      );
    }

    candidate.STRIPE_SECRET_KEY = secretKey;
    candidate.STRIPE_WEBHOOK_SECRET = webhookSecret;
    candidate.STRIPE_ANNUAL_PRICE_ID = priceId;
    candidate.STRIPE_PORTAL_CONFIGURATION_ID = portalConfigId;
    candidate.STRIPE_CHECKOUT_SUCCESS_URL = checkoutSuccessUrl;
    candidate.STRIPE_CHECKOUT_CANCEL_URL = checkoutCancelUrl;
    candidate.STRIPE_PORTAL_RETURN_URL = portalReturnUrl;
    candidate.STRIPE_API_VERSION = STRIPE_API_VERSION;
    candidate.STRIPE_EXPECTED_LIVEMODE = expectedLivemode;
    candidate.CEREMONY_RATE_LIMIT_HASH_KEY = source.CEREMONY_RATE_LIMIT_HASH_KEY;
  }

  if (googlePlayBillingEnabled) {
    const packageName = source.GOOGLE_PLAY_PACKAGE_NAME;
    const subscriptionId = source.GOOGLE_PLAY_SUBSCRIPTION_ID;
    const serviceAccountJson = source.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;

    if (
      !isNonEmptyString(packageName) ||
      packageName.length < 3 ||
      !packageName.includes('.') ||
      packageName.includes(' ')
    ) {
      throw new Error(
        'Invalid environment configuration: GOOGLE_PLAY_PACKAGE_NAME must be a non-empty Android package name when GOOGLE_PLAY_BILLING_ENABLED is true',
      );
    }
    if (!isNonEmptyString(subscriptionId) || subscriptionId.length < 1) {
      throw new Error(
        'Invalid environment configuration: GOOGLE_PLAY_SUBSCRIPTION_ID must be a non-empty subscription product id when GOOGLE_PLAY_BILLING_ENABLED is true',
      );
    }
    if (!isNonEmptyString(serviceAccountJson) || serviceAccountJson.length < 32) {
      throw new Error(
        'Invalid environment configuration: GOOGLE_PLAY_SERVICE_ACCOUNT_JSON must be a non-empty service account JSON string when GOOGLE_PLAY_BILLING_ENABLED is true',
      );
    }

    let parsedAccount: unknown;
    try {
      parsedAccount = JSON.parse(serviceAccountJson) as unknown;
    } catch {
      throw new Error(
        'Invalid environment configuration: GOOGLE_PLAY_SERVICE_ACCOUNT_JSON must be valid JSON when GOOGLE_PLAY_BILLING_ENABLED is true',
      );
    }
    if (
      typeof parsedAccount !== 'object' ||
      parsedAccount === null ||
      Array.isArray(parsedAccount)
    ) {
      throw new Error(
        'Invalid environment configuration: GOOGLE_PLAY_SERVICE_ACCOUNT_JSON must be a JSON object when GOOGLE_PLAY_BILLING_ENABLED is true',
      );
    }
    const accountRecord = parsedAccount as Record<string, unknown>;
    const clientEmail = accountRecord.client_email;
    const privateKey = accountRecord.private_key;
    if (typeof clientEmail !== 'string' || clientEmail.length === 0 || !clientEmail.includes('@')) {
      throw new Error(
        'Invalid environment configuration: GOOGLE_PLAY_SERVICE_ACCOUNT_JSON must include a valid client_email when GOOGLE_PLAY_BILLING_ENABLED is true',
      );
    }
    if (
      typeof privateKey !== 'string' ||
      privateKey.length < 32 ||
      !privateKey.includes('PRIVATE KEY')
    ) {
      throw new Error(
        'Invalid environment configuration: GOOGLE_PLAY_SERVICE_ACCOUNT_JSON must include a valid private_key when GOOGLE_PLAY_BILLING_ENABLED is true',
      );
    }

    candidate.GOOGLE_PLAY_PACKAGE_NAME = packageName;
    candidate.GOOGLE_PLAY_SUBSCRIPTION_ID = subscriptionId;
    candidate.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON = serviceAccountJson;
  }

  if (googlePlayRtdnIngressEnabled) {
    const audience = source.GOOGLE_PLAY_RTDN_OIDC_AUDIENCE;
    const serviceAccountEmail = source.GOOGLE_PLAY_RTDN_PUSH_SERVICE_ACCOUNT_EMAIL;
    const subscription = source.GOOGLE_PLAY_RTDN_PUBSUB_SUBSCRIPTION;
    const packageName = source.GOOGLE_PLAY_PACKAGE_NAME;

    if (!isNonEmptyString(audience) || !isRtdnAudience(audience)) {
      throw new Error(
        'Invalid environment configuration: GOOGLE_PLAY_RTDN_OIDC_AUDIENCE must be an absolute https URL without wildcard, query, or fragment when GOOGLE_PLAY_RTDN_INGRESS_ENABLED is true',
      );
    }
    if (!isNonEmptyString(serviceAccountEmail) || !isEmailAddressShape(serviceAccountEmail)) {
      throw new Error(
        'Invalid environment configuration: GOOGLE_PLAY_RTDN_PUSH_SERVICE_ACCOUNT_EMAIL must be a valid email address when GOOGLE_PLAY_RTDN_INGRESS_ENABLED is true',
      );
    }
    if (
      !isNonEmptyString(subscription) ||
      !/^projects\/[^/\s]+\/subscriptions\/[^/\s]+$/.test(subscription)
    ) {
      throw new Error(
        'Invalid environment configuration: GOOGLE_PLAY_RTDN_PUBSUB_SUBSCRIPTION must match projects/{project}/subscriptions/{subscription} when GOOGLE_PLAY_RTDN_INGRESS_ENABLED is true',
      );
    }
    if (
      !isNonEmptyString(packageName) ||
      packageName.length < 3 ||
      !packageName.includes('.') ||
      packageName.includes(' ')
    ) {
      throw new Error(
        'Invalid environment configuration: GOOGLE_PLAY_PACKAGE_NAME must be a non-empty Android package name when GOOGLE_PLAY_RTDN_INGRESS_ENABLED is true',
      );
    }

    candidate.GOOGLE_PLAY_RTDN_OIDC_AUDIENCE = audience;
    candidate.GOOGLE_PLAY_RTDN_PUSH_SERVICE_ACCOUNT_EMAIL = serviceAccountEmail;
    candidate.GOOGLE_PLAY_RTDN_PUBSUB_SUBSCRIPTION = subscription;
    candidate.GOOGLE_PLAY_PACKAGE_NAME = packageName;
  }

  if (!isNonEmptyString(candidate.DATABASE_URL)) {
    throw new Error('Invalid environment configuration: DATABASE_URL is required');
  }

  if (runtimeIsProduction) {
    if (railwayCommitSha === undefined && appCommitSha === undefined) {
      throw new Error(
        'Invalid environment configuration: missing deployment commit identity (RAILWAY_GIT_COMMIT_SHA or APP_COMMIT_SHA required when APP_ENV is production)',
      );
    }
    assertNoLocalDatabaseUrl(candidate.DATABASE_URL);
    const webauthnEnabled =
      webauthnRegistrationEnabled || passkeyAuthenticationEnabled || accountRecoveryEnabled;
    if (webauthnEnabled) {
      const originsRaw = source.WEBAUTHN_ALLOWED_ORIGINS;
      if (typeof originsRaw === 'string' && originsRaw.length > 0) {
        for (const part of originsRaw.split(',')) {
          const lower = part.trim().toLowerCase();
          if (lower.includes('localhost') || lower.includes('127.0.0.1')) {
            throw new Error(
              'Invalid environment configuration: WEBAUTHN_ALLOWED_ORIGINS must not include localhost in production',
            );
          }
        }
      }
      const rpId = source.WEBAUTHN_RP_ID;
      if (typeof rpId === 'string' && rpId.toLowerCase() === 'localhost') {
        throw new Error(
          'Invalid environment configuration: WEBAUTHN_RP_ID must not be localhost in production',
        );
      }
    }
    // Reject known dev/CI hash placeholders if any are set to those exact values.
    for (const key of [
      'SESSION_TOKEN_HASH_KEY',
      'EMAIL_VERIFICATION_HASH_KEY',
      'CEREMONY_RATE_LIMIT_HASH_KEY',
      'WEBAUTHN_CHALLENGE_HASH_KEY',
      'PASSKEY_AUTHENTICATION_CHALLENGE_HASH_KEY',
      'ACCOUNT_RECOVERY_HASH_KEY',
      'ACCOUNT_RECOVERY_TOKEN_HASH_KEY',
    ] as const) {
      const value = candidate[key];
      if (typeof value === 'string' && KNOWN_CI_HASH_KEY_PLACEHOLDERS.has(value)) {
        throw new Error(
          `Invalid environment configuration: ${key} must not equal a known CI placeholder in production`,
        );
      }
    }
    if (stripeBillingEnabled && candidate.STRIPE_EXPECTED_LIVEMODE !== true) {
      throw new Error(
        'Invalid environment configuration: STRIPE_EXPECTED_LIVEMODE must be true when STRIPE_BILLING_ENABLED is true in production',
      );
    }
  }

  if (runtimeIsStaging) {
    if (railwayCommitSha === undefined && appCommitSha === undefined) {
      throw new Error(
        'Invalid environment configuration: missing deployment commit identity (RAILWAY_GIT_COMMIT_SHA or APP_COMMIT_SHA required when APP_ENV is staging)',
      );
    }
    if (stripeBillingEnabled) {
      if (candidate.STRIPE_EXPECTED_LIVEMODE === true) {
        throw new Error(
          'Invalid environment configuration: STRIPE_EXPECTED_LIVEMODE must be false when APP_ENV is staging',
        );
      }
      const secretKey = candidate.STRIPE_SECRET_KEY;
      if (typeof secretKey === 'string' && secretKey.startsWith('sk_live_')) {
        throw new Error(
          'Invalid environment configuration: STRIPE_SECRET_KEY must not be a live key when APP_ENV is staging',
        );
      }
    }
  }

  // Canonical browser origin allowlist (WebAuthn + runtime CORS). Retain and
  // validate whenever set, even if ceremony features are disabled.
  // Deployment host policy is classified by APP_ENV (not NODE_ENV).
  if (isNonEmptyString(source.WEBAUTHN_ALLOWED_ORIGINS)) {
    parseAllowedOrigins(source.WEBAUTHN_ALLOWED_ORIGINS, { nodeEnv, appEnv });
    candidate.WEBAUTHN_ALLOWED_ORIGINS = source.WEBAUTHN_ALLOWED_ORIGINS;
  }

  if (!Value.Check(EnvSchema, candidate)) {
    const details = [...Value.Errors(EnvSchema, candidate)]
      .map((error) => sanitizeEnvErrorPath(error.path || '/env', error.message))
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }

  return Value.Decode(EnvSchema, candidate);
}

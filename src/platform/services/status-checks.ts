import type { Env } from '../../config/env.js';
import { STRIPE_API_VERSION, type StripeApiVersion } from '../../config/env.js';
import { createOfficialStripeAdapter } from '../../billing/stripe-adapter.js';

import type {
  PlatformBackupVerificationRow,
  PlatformRestoreDrillAttestationRow,
} from '../../db/schema.js';
import { assessBackupComponent } from './backup.js';
import { assessRestoreComponent } from './restore-drill.js';

/**
 * Distinct operational component checks for GET /v1/platform/status.
 *
 * Scope: API process, database readiness, email provider, Stripe billing,
 * platform-managed Postgres PITR backup attestation, and restore-drill
 * attestation (never executes restore).
 * No secret leakage in details. Alert/uptime persistence is handled
 * separately from these probe results.
 */

export type PlatformComponentStatus =
  'ok' | 'degraded' | 'fail' | 'timeout' | 'disabled' | 'misconfigured';

export type PlatformComponentCheck = {
  readonly status: PlatformComponentStatus;
  readonly detail: string | null;
};

export type PlatformOperationalComponents = {
  readonly api: PlatformComponentCheck;
  readonly database: PlatformComponentCheck;
  readonly email: PlatformComponentCheck;
  readonly stripe: PlatformComponentCheck;
  readonly backup: PlatformComponentCheck;
  readonly restore: PlatformComponentCheck;
};

export type DatabaseComponentInput = {
  readonly shuttingDown: boolean;
  readonly connection: 'ok' | 'fail' | 'timeout';
  readonly migrations: 'ok' | 'fail' | 'unknown';
};

export type StatusCheckFetch = (
  input: string | URL,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}>;

async function readResendErrorName(response: {
  json?: () => Promise<unknown>;
}): Promise<string | null> {
  if (typeof response.json !== 'function') {
    return null;
  }
  try {
    const body = await response.json();
    if (
      body !== null &&
      typeof body === 'object' &&
      'name' in body &&
      typeof (body as { name: unknown }).name === 'string'
    ) {
      return (body as { name: string }).name;
    }
  } catch {
    return null;
  }
  return null;
}

export type StripePriceProbe = (input: {
  secretKey: string;
  apiVersion: StripeApiVersion;
  priceId: string;
}) => Promise<void>;

const DEFAULT_PROBE_TIMEOUT_MS = 2_500;

export function assessApiComponent(input: {
  shuttingDown: boolean;
  environment: string;
}): PlatformComponentCheck {
  if (input.shuttingDown) {
    return { status: 'degraded', detail: 'shutting_down' };
  }
  return { status: 'ok', detail: `environment=${input.environment}` };
}

export function assessDatabaseComponent(input: DatabaseComponentInput): PlatformComponentCheck {
  if (input.shuttingDown) {
    return { status: 'fail', detail: 'connection=fail;migrations=unknown;shutting_down' };
  }
  if (input.connection === 'timeout') {
    return { status: 'timeout', detail: 'connection=timeout;migrations=unknown' };
  }
  if (input.connection !== 'ok') {
    return { status: 'fail', detail: 'connection=fail;migrations=unknown' };
  }
  if (input.migrations !== 'ok') {
    return {
      status: 'degraded',
      detail: `connection=ok;migrations=${input.migrations}`,
    };
  }
  return { status: 'ok', detail: 'connection=ok;migrations=ok' };
}

export async function assessEmailComponent(
  env: Env,
  options?: {
    fetchImpl?: StatusCheckFetch;
    timeoutMs?: number;
  },
): Promise<PlatformComponentCheck> {
  if (!env.EMAIL_VERIFICATION_ENABLED) {
    return { status: 'disabled', detail: 'email_verification_disabled' };
  }

  const mode = env.EMAIL_VERIFICATION_DELIVERY_MODE;
  if (mode === undefined) {
    return { status: 'misconfigured', detail: 'delivery_mode_missing' };
  }
  if (mode === 'test' || mode === 'development') {
    return { status: 'ok', detail: `delivery_mode=${mode}` };
  }

  // Remaining supported mode is resend (env validation rejects other values).
  const apiKey = env.EMAIL_VERIFICATION_RESEND_API_KEY;
  const fromAddress = env.EMAIL_VERIFICATION_FROM_ADDRESS;
  if (!apiKey || apiKey.trim().length < 20 || !fromAddress || fromAddress.trim().length < 3) {
    return { status: 'misconfigured', detail: 'resend_config_incomplete' };
  }

  const fetchImpl = options?.fetchImpl ?? defaultFetch;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    // Read-only Resend probe (no send). Confirms API key + provider reachability.
    const response = await fetchImpl('https://api.resend.com/domains', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (response.ok) {
      return { status: 'ok', detail: 'resend_reachable' };
    }
    if (response.status === 401 || response.status === 403) {
      // Send-only Resend keys are valid for delivery but cannot GET /domains.
      // Treat that provider response as configured/reachable, not misconfigured.
      const errorName = await readResendErrorName(response);
      if (errorName === 'restricted_api_key') {
        return { status: 'ok', detail: 'resend_send_only_key' };
      }
      return { status: 'misconfigured', detail: `resend_http_${String(response.status)}` };
    }
    return { status: 'fail', detail: `resend_http_${String(response.status)}` };
  } catch (error: unknown) {
    if (isAbortError(error)) {
      return { status: 'timeout', detail: 'resend_timeout' };
    }
    return { status: 'fail', detail: 'resend_unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

export async function assessStripeComponent(
  env: Env,
  options?: {
    probePrice?: StripePriceProbe;
    timeoutMs?: number;
  },
): Promise<PlatformComponentCheck> {
  if (!env.STRIPE_BILLING_ENABLED) {
    return { status: 'disabled', detail: 'stripe_billing_disabled' };
  }

  const secretKey = env.STRIPE_SECRET_KEY;
  const priceId = env.STRIPE_ANNUAL_PRICE_ID;
  if (!secretKey || secretKey.trim().length < 20 || !priceId || priceId.trim().length < 6) {
    return { status: 'misconfigured', detail: 'stripe_config_incomplete' };
  }

  const apiVersion = env.STRIPE_API_VERSION ?? STRIPE_API_VERSION;
  const probe = options?.probePrice ?? defaultStripePriceProbe;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  try {
    await withTimeout(
      probe({
        secretKey,
        apiVersion,
        priceId,
      }),
      timeoutMs,
    );
    return { status: 'ok', detail: 'price_reachable' };
  } catch (error: unknown) {
    if (isTimeoutError(error)) {
      return { status: 'timeout', detail: 'stripe_timeout' };
    }
    return { status: 'fail', detail: 'stripe_unreachable' };
  }
}

export async function collectOperationalComponents(input: {
  env: Env;
  shuttingDown: boolean;
  databaseConnection: 'ok' | 'fail' | 'timeout';
  migrations: 'ok' | 'fail' | 'unknown';
  latestBackupVerification?: PlatformBackupVerificationRow | null;
  latestRestoreDrillAttestation?: PlatformRestoreDrillAttestationRow | null;
  nowIso?: string;
  fetchImpl?: StatusCheckFetch;
  probeStripePrice?: StripePriceProbe;
  timeoutMs?: number;
}): Promise<PlatformOperationalComponents> {
  const api = assessApiComponent({
    shuttingDown: input.shuttingDown,
    environment: input.env.APP_ENV,
  });
  const database = assessDatabaseComponent({
    shuttingDown: input.shuttingDown,
    connection: input.databaseConnection,
    migrations: input.migrations,
  });
  const emailOptions: {
    fetchImpl?: StatusCheckFetch;
    timeoutMs?: number;
  } = {};
  if (input.fetchImpl) emailOptions.fetchImpl = input.fetchImpl;
  if (input.timeoutMs !== undefined) emailOptions.timeoutMs = input.timeoutMs;

  const stripeOptions: {
    probePrice?: StripePriceProbe;
    timeoutMs?: number;
  } = {};
  if (input.probeStripePrice) stripeOptions.probePrice = input.probeStripePrice;
  if (input.timeoutMs !== undefined) stripeOptions.timeoutMs = input.timeoutMs;

  const [email, stripe] = await Promise.all([
    assessEmailComponent(input.env, emailOptions),
    assessStripeComponent(input.env, stripeOptions),
  ]);
  const nowIso = input.nowIso ?? new Date().toISOString();
  const backup = assessBackupComponent({
    env: input.env,
    latestVerification: input.latestBackupVerification ?? null,
    nowIso,
  });
  const restore = assessRestoreComponent({
    env: input.env,
    latestAttestation: input.latestRestoreDrillAttestation ?? null,
    nowIso,
  });
  return { api, database, email, stripe, backup, restore };
}

async function defaultFetch(
  input: string | URL,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
): Promise<{ ok: boolean; status: number }> {
  const requestInit: RequestInit = {
    method: init?.method ?? 'GET',
  };
  if (init?.headers) requestInit.headers = init.headers;
  if (init?.signal) requestInit.signal = init.signal;
  const response = await fetch(input, requestInit);
  return { ok: response.ok, status: response.status };
}

async function defaultStripePriceProbe(input: {
  secretKey: string;
  apiVersion: StripeApiVersion;
  priceId: string;
}): Promise<void> {
  const adapter = createOfficialStripeAdapter(input.secretKey, input.apiVersion);
  await adapter.retrievePrice(input.priceId);
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: string }).name === 'AbortError'
  );
}

class TimeoutError extends Error {
  constructor() {
    super('timeout');
    this.name = 'TimeoutError';
  }
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof TimeoutError || isAbortError(error);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new TimeoutError());
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

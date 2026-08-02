import { describe, expect, it } from 'vitest';
import type { Env } from '../src/config/env.js';
import {
  assessApiComponent,
  assessDatabaseComponent,
  assessEmailComponent,
  assessStripeComponent,
  collectOperationalComponents,
} from '../src/platform/services/status-checks.js';

function baseEnv(overrides: Partial<Env> = {}): Env {
  return {
    APP_ENV: 'test',
    EMAIL_VERIFICATION_ENABLED: false,
    STRIPE_BILLING_ENABLED: false,
    ...overrides,
  } as Env;
}

describe('platform operational status checks', () => {
  it('assesses API as ok when process is serving', () => {
    expect(assessApiComponent({ shuttingDown: false, environment: 'staging' })).toEqual({
      status: 'ok',
      detail: 'environment=staging',
    });
  });

  it('assesses API as degraded while shutting down', () => {
    expect(assessApiComponent({ shuttingDown: true, environment: 'staging' })).toEqual({
      status: 'degraded',
      detail: 'shutting_down',
    });
  });

  it('maps database connection and migration outcomes', () => {
    expect(
      assessDatabaseComponent({
        shuttingDown: false,
        connection: 'ok',
        migrations: 'ok',
      }),
    ).toEqual({ status: 'ok', detail: 'connection=ok;migrations=ok' });

    expect(
      assessDatabaseComponent({
        shuttingDown: false,
        connection: 'ok',
        migrations: 'fail',
      }),
    ).toEqual({ status: 'degraded', detail: 'connection=ok;migrations=fail' });

    expect(
      assessDatabaseComponent({
        shuttingDown: false,
        connection: 'timeout',
        migrations: 'unknown',
      }),
    ).toEqual({ status: 'timeout', detail: 'connection=timeout;migrations=unknown' });
  });

  it('reports email disabled / local delivery / resend probe outcomes', async () => {
    await expect(assessEmailComponent(baseEnv())).resolves.toEqual({
      status: 'disabled',
      detail: 'email_verification_disabled',
    });

    await expect(
      assessEmailComponent(
        baseEnv({
          EMAIL_VERIFICATION_ENABLED: true,
          EMAIL_VERIFICATION_DELIVERY_MODE: 'development',
        }),
      ),
    ).resolves.toEqual({ status: 'ok', detail: 'delivery_mode=development' });

    await expect(
      assessEmailComponent(
        baseEnv({
          EMAIL_VERIFICATION_ENABLED: true,
          EMAIL_VERIFICATION_DELIVERY_MODE: 'resend',
          EMAIL_VERIFICATION_RESEND_API_KEY: 're_test_key_1234567890',
          EMAIL_VERIFICATION_FROM_ADDRESS: 'ops@example.com',
        }),
        {
          fetchImpl: () => Promise.resolve({ ok: true, status: 200 }),
        },
      ),
    ).resolves.toEqual({ status: 'ok', detail: 'resend_reachable' });

    await expect(
      assessEmailComponent(
        baseEnv({
          EMAIL_VERIFICATION_ENABLED: true,
          EMAIL_VERIFICATION_DELIVERY_MODE: 'resend',
          EMAIL_VERIFICATION_RESEND_API_KEY: 're_test_key_1234567890',
          EMAIL_VERIFICATION_FROM_ADDRESS: 'ops@example.com',
        }),
        {
          fetchImpl: () => Promise.resolve({ ok: false, status: 401 }),
        },
      ),
    ).resolves.toEqual({ status: 'misconfigured', detail: 'resend_http_401' });

    await expect(
      assessEmailComponent(
        baseEnv({
          EMAIL_VERIFICATION_ENABLED: true,
          EMAIL_VERIFICATION_DELIVERY_MODE: 'resend',
          EMAIL_VERIFICATION_RESEND_API_KEY: 're_test_key_1234567890',
          EMAIL_VERIFICATION_FROM_ADDRESS: 'ops@example.com',
        }),
        {
          fetchImpl: () =>
            Promise.resolve({
              ok: false,
              status: 401,
              json: () =>
                Promise.resolve({
                  statusCode: 401,
                  name: 'restricted_api_key',
                  message: 'This API key is restricted to only send emails',
                }),
            }),
        },
      ),
    ).resolves.toEqual({ status: 'ok', detail: 'resend_send_only_key' });
  });

  it('reports stripe disabled / misconfigured / reachable outcomes', async () => {
    await expect(assessStripeComponent(baseEnv())).resolves.toEqual({
      status: 'disabled',
      detail: 'stripe_billing_disabled',
    });

    await expect(
      assessStripeComponent(
        baseEnv({
          STRIPE_BILLING_ENABLED: true,
        }),
      ),
    ).resolves.toEqual({ status: 'misconfigured', detail: 'stripe_config_incomplete' });

    await expect(
      assessStripeComponent(
        baseEnv({
          STRIPE_BILLING_ENABLED: true,
          STRIPE_SECRET_KEY: 'sk_test_12345678901234567890',
          STRIPE_ANNUAL_PRICE_ID: 'price_test_annual',
          STRIPE_API_VERSION: '2026-06-24.dahlia',
        }),
        {
          probePrice: () => Promise.resolve(),
        },
      ),
    ).resolves.toEqual({ status: 'ok', detail: 'price_reachable' });

    await expect(
      assessStripeComponent(
        baseEnv({
          STRIPE_BILLING_ENABLED: true,
          STRIPE_SECRET_KEY: 'sk_test_12345678901234567890',
          STRIPE_ANNUAL_PRICE_ID: 'price_test_annual',
          STRIPE_API_VERSION: '2026-06-24.dahlia',
        }),
        {
          probePrice: () => Promise.reject(new Error('stripe down')),
        },
      ),
    ).resolves.toEqual({ status: 'fail', detail: 'stripe_unreachable' });
  });

  it('collects all operational components together', async () => {
    const components = await collectOperationalComponents({
      env: baseEnv({
        APP_ENV: 'staging',
        EMAIL_VERIFICATION_ENABLED: true,
        EMAIL_VERIFICATION_DELIVERY_MODE: 'test',
        STRIPE_BILLING_ENABLED: false,
        DATABASE_BACKUP_PROVIDER: 'none',
        DATABASE_BACKUP_PITR_ENABLED: false,
      }),
      shuttingDown: false,
      databaseConnection: 'ok',
      migrations: 'ok',
      nowIso: '2026-08-01T12:00:00.000Z',
    });

    expect(components.api.status).toBe('ok');
    expect(components.database.status).toBe('ok');
    expect(components.email).toEqual({ status: 'ok', detail: 'delivery_mode=test' });
    expect(components.stripe).toEqual({ status: 'disabled', detail: 'stripe_billing_disabled' });
    expect(components.backup).toEqual({ status: 'misconfigured', detail: 'pitr_not_configured' });
    expect(components.restore).toEqual({ status: 'misconfigured', detail: 'backup_pitr_required' });
  });
});

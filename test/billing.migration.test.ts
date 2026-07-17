import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { requireDatabaseUrl, resetAndMigrate } from './helpers/pg.js';

describe('billing migration 0011', () => {
  const databaseUrl = requireDatabaseUrl();
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 1 });
    await resetAndMigrate(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('creates the stripe_customer_links table with the expected columns and uniques', async () => {
    const cols = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'town' AND table_name = 'stripe_customer_links'
       ORDER BY column_name`,
    );
    const names = cols.rows.map((row) => row.column_name);
    expect(names).toEqual(
      expect.arrayContaining([
        'id',
        'account_id',
        'stripe_customer_id',
        'billing_reference',
        'created_at',
        'updated_at',
      ]),
    );

    const uniques = await pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE connamespace = 'town'::regnamespace
         AND contype = 'u'
         AND conrelid = 'town.stripe_customer_links'::regclass`,
    );
    const uniqueNames = uniques.rows.map((r) => r.conname);
    expect(uniqueNames).toEqual(
      expect.arrayContaining([
        'stripe_customer_links_account_id_unique',
        'stripe_customer_links_stripe_customer_id_unique',
        'stripe_customer_links_billing_reference_unique',
      ]),
    );

    const fks = await pool.query<{ conname: string; confdeltype: string }>(
      `SELECT conname, confdeltype FROM pg_constraint
       WHERE connamespace = 'town'::regnamespace
         AND contype = 'f'
         AND conrelid = 'town.stripe_customer_links'::regclass`,
    );
    expect(fks.rows).toHaveLength(1);
    expect(fks.rows[0]?.confdeltype).toBe('r');

    const indexes = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'town' AND tablename = 'stripe_customer_links'`,
    );
    expect(indexes.rows.map((r) => r.indexname)).toEqual(
      expect.arrayContaining(['stripe_customer_links_stripe_customer_id_idx']),
    );
  });

  it('creates the stripe_checkout_attempts table with bounded statuses', async () => {
    const cols = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'town' AND table_name = 'stripe_checkout_attempts'`,
    );
    expect(cols.rows.map((r) => r.column_name)).toEqual(
      expect.arrayContaining([
        'id',
        'account_id',
        'stripe_checkout_session_id',
        'status',
        'created_at',
        'expires_at',
        'completed_at',
      ]),
    );

    const checks = await pool.query<{ conname: string; definition: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE connamespace = 'town'::regnamespace
         AND contype = 'c'
         AND conrelid = 'town.stripe_checkout_attempts'::regclass`,
    );
    const statusCheck = checks.rows.find(
      (row) => row.conname === 'stripe_checkout_attempts_status_valid',
    );
    expect(statusCheck?.definition).toContain("'creating'");
    expect(statusCheck?.definition).toContain("'open'");
    expect(statusCheck?.definition).toContain("'completed'");
    expect(statusCheck?.definition).toContain("'expired'");
    expect(statusCheck?.definition).toContain("'failed'");

    const indexes = await pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = 'town' AND tablename = 'stripe_checkout_attempts'`,
    );
    const partialUnique = indexes.rows.find(
      (row) => row.indexname === 'stripe_checkout_attempts_session_id_unique',
    );
    expect(partialUnique?.indexdef).toMatch(/WHERE.*is not null/i);
  });

  it('extends ceremony rate-limit scopes with billing_* buckets', async () => {
    const rows = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE connamespace = 'town'::regnamespace
         AND conname = 'ceremony_rate_limits_scope_valid'`,
    );
    const def = rows.rows[0]?.definition ?? '';
    expect(def).toContain("'billing_checkout_account'");
    expect(def).toContain("'billing_portal_account'");
  });

  it('extends identity security event types with stripe_* events', async () => {
    const rows = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE connamespace = 'town'::regnamespace
         AND conname = 'identity_security_events_type_valid'`,
    );
    const def = rows.rows[0]?.definition ?? '';
    for (const type of [
      'stripe_checkout_session_created',
      'stripe_customer_linked',
      'stripe_webhook_received',
      'stripe_webhook_verified',
      'stripe_webhook_replayed',
      'stripe_webhook_rejected',
      'stripe_subscription_linked',
      'stripe_invoice_paid',
      'stripe_cancellation_scheduled',
      'stripe_cancellation_removed',
      'stripe_subscription_deleted',
      'stripe_payment_failed',
      'stripe_price_mismatch',
    ]) {
      expect(def).toContain(`'${type}'`);
    }
  });

  it('has a drizzle migration history at least at 12 entries (prior 11 + 0011)', async () => {
    const count = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM drizzle.__drizzle_migrations',
    );
    expect(Number(count.rows[0]?.count ?? 0)).toBeGreaterThanOrEqual(12);
  });
});

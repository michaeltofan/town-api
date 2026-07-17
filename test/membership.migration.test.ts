import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { requireDatabaseUrl, resetAndMigrate } from './helpers/pg.js';

describe('membership migration 0010', () => {
  const databaseUrl = requireDatabaseUrl();
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 1 });
    await resetAndMigrate(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('creates the membership_entitlements table with the expected columns and constraints', async () => {
    const cols = await pool.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_schema = 'town' AND table_name = 'membership_entitlements'
       ORDER BY column_name`,
    );
    const names = cols.rows.map((row) => row.column_name);
    expect(names).toEqual(
      expect.arrayContaining([
        'id',
        'account_id',
        'status',
        'access_until',
        'cancel_at_period_end',
        'source',
        'source_customer_id',
        'source_subscription_id',
        'activated_at',
        'cancellation_requested_at',
        'expired_at',
        'created_at',
        'updated_at',
        'version',
      ]),
    );

    const checks = await pool.query<{ conname: string }>(
      `SELECT conname
       FROM pg_constraint
       WHERE connamespace = 'town'::regnamespace
         AND contype = 'c'
         AND conrelid = 'town.membership_entitlements'::regclass
       ORDER BY conname`,
    );
    const checkNames = checks.rows.map((row) => row.conname);
    expect(checkNames).toEqual(
      expect.arrayContaining([
        'membership_entitlements_status_valid',
        'membership_entitlements_source_valid',
        'membership_entitlements_version_positive',
        'membership_entitlements_updated_after_created',
        'membership_entitlements_state_invariants',
      ]),
    );

    const unique = await pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE connamespace = 'town'::regnamespace
         AND contype = 'u'
         AND conrelid = 'town.membership_entitlements'::regclass`,
    );
    expect(unique.rows.map((r) => r.conname)).toContain(
      'membership_entitlements_account_id_unique',
    );

    const indexes = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'town' AND tablename = 'membership_entitlements'`,
    );
    const indexNames = indexes.rows.map((r) => r.indexname);
    expect(indexNames).toEqual(
      expect.arrayContaining([
        'membership_entitlements_status_access_until_idx',
        'membership_entitlements_stripe_subscription_unique',
      ]),
    );

    const fks = await pool.query<{ conname: string; confdeltype: string }>(
      `SELECT conname, confdeltype FROM pg_constraint
       WHERE connamespace = 'town'::regnamespace
         AND contype = 'f'
         AND conrelid = 'town.membership_entitlements'::regclass`,
    );
    expect(fks.rows).toHaveLength(1);
    expect(fks.rows[0]?.confdeltype).toBe('r');
  });

  it('creates the membership_source_events table with the expected columns and constraints', async () => {
    const cols = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'town' AND table_name = 'membership_source_events'`,
    );
    const names = cols.rows.map((r) => r.column_name);
    expect(names).toEqual(
      expect.arrayContaining([
        'id',
        'source',
        'source_event_id',
        'event_type',
        'account_id',
        'payload_hash',
        'effective_at',
        'processed_at',
        'result',
        'created_at',
      ]),
    );

    const checks = await pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE connamespace = 'town'::regnamespace
         AND contype = 'c'
         AND conrelid = 'town.membership_source_events'::regclass
       ORDER BY conname`,
    );
    const checkNames = checks.rows.map((r) => r.conname);
    expect(checkNames).toEqual(
      expect.arrayContaining([
        'membership_source_events_source_valid',
        'membership_source_events_event_type_valid',
        'membership_source_events_result_valid',
        'membership_source_events_payload_hash_sha256',
      ]),
    );

    const unique = await pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE connamespace = 'town'::regnamespace
         AND contype = 'u'
         AND conrelid = 'town.membership_source_events'::regclass`,
    );
    expect(unique.rows.map((r) => r.conname)).toContain(
      'membership_source_events_source_event_unique',
    );
  });

  it('extends allowed ceremony rate-limit scopes and identity security event types', async () => {
    const scopes = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE connamespace = 'town'::regnamespace
         AND conname = 'ceremony_rate_limits_scope_valid'`,
    );
    expect(scopes.rows[0]?.definition).toContain("'membership_inventory_account'");

    const events = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE connamespace = 'town'::regnamespace
         AND conname = 'identity_security_events_type_valid'`,
    );
    expect(events.rows[0]?.definition).toContain("'membership_created'");
    expect(events.rows[0]?.definition).toContain("'membership_activated'");
    expect(events.rows[0]?.definition).toContain("'membership_cancellation_scheduled'");
    expect(events.rows[0]?.definition).toContain("'membership_reactivated'");
    expect(events.rows[0]?.definition).toContain("'membership_expired'");
    expect(events.rows[0]?.definition).toContain("'membership_event_replayed'");
    expect(events.rows[0]?.definition).toContain("'membership_event_rejected'");
    expect(events.rows[0]?.definition).toContain("'civic_participation_denied'");
  });

  it('does not create legacy Stripe-branded tables', async () => {
    // Slice 2 introduces the approved stripe_customer_links and stripe_checkout_attempts
    // tables; the legacy singular 'stripe_customers' and payment table names remain forbidden.
    const forbidden = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'town'
         AND table_name IN ('stripe_customers', 'stripe_subscriptions', 'stripe_events', 'stripe_webhooks', 'payments', 'billing')`,
    );
    expect(forbidden.rows).toHaveLength(0);
  });

  it('keeps the drizzle migration history at least at 11 entries (prior 10 + 0010)', async () => {
    const count = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM drizzle.__drizzle_migrations',
    );
    expect(Number(count.rows[0]?.count ?? 0)).toBeGreaterThanOrEqual(11);
  });
});

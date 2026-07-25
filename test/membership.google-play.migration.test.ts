import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { requireDatabaseUrl, resetAndMigrate } from './helpers/pg.js';

describe('membership migration 0014 google play paid_pending_binding foundation', () => {
  const databaseUrl = requireDatabaseUrl();
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 1 });
    await resetAndMigrate(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('creates google_play_purchase_links with token uniqueness and FKs', async () => {
    const cols = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'town' AND table_name = 'google_play_purchase_links'
       ORDER BY column_name`,
    );
    expect(cols.rows.map((row) => row.column_name)).toEqual(
      expect.arrayContaining([
        'id',
        'account_id',
        'entitlement_id',
        'purchase_token',
        'package_name',
        'subscription_id',
        'expiry_time',
        'created_at',
        'updated_at',
      ]),
    );

    const uniques = await pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE connamespace = 'town'::regnamespace
         AND contype = 'u'
         AND conrelid = 'town.google_play_purchase_links'::regclass`,
    );
    expect(uniques.rows.map((r) => r.conname)).toContain(
      'google_play_purchase_links_purchase_token_unique',
    );

    const fks = await pool.query<{ conname: string; confdeltype: string }>(
      `SELECT conname, confdeltype FROM pg_constraint
       WHERE connamespace = 'town'::regnamespace
         AND contype = 'f'
         AND conrelid = 'town.google_play_purchase_links'::regclass`,
    );
    expect(fks.rows).toHaveLength(2);
    expect(fks.rows.every((row) => row.confdeltype === 'r')).toBe(true);
  });

  it('extends membership source/status/event-type checks for google_play pre-binding', async () => {
    const source = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE connamespace = 'town'::regnamespace
         AND conname = 'membership_entitlements_source_valid'`,
    );
    expect(source.rows[0]?.definition).toContain("'google_play'");
    expect(source.rows[0]?.definition).toContain("'stripe'");
    expect(source.rows[0]?.definition).toContain("'test_fixture'");

    const status = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE connamespace = 'town'::regnamespace
         AND conname = 'membership_entitlements_status_valid'`,
    );
    expect(status.rows[0]?.definition).toContain("'paid_pending_binding'");

    const eventType = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE connamespace = 'town'::regnamespace
         AND conname = 'membership_source_events_event_type_valid'`,
    );
    expect(eventType.rows[0]?.definition).toContain("'provision_paid_pending_binding'");

    const security = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE connamespace = 'town'::regnamespace
         AND conname = 'identity_security_events_type_valid'`,
    );
    expect(security.rows[0]?.definition).toContain("'membership_paid_pending_binding_provisioned'");
  });
});

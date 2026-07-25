import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { requireDatabaseUrl, resetAndMigrate } from './helpers/pg.js';

describe('membership migration 0015 finalize_paid_pending_binding', () => {
  const databaseUrl = requireDatabaseUrl();
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 1 });
    await resetAndMigrate(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('expands membership_source_events_event_type_valid with finalize_paid_pending_binding only', async () => {
    const eventType = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE connamespace = 'town'::regnamespace
         AND conname = 'membership_source_events_event_type_valid'`,
    );
    expect(eventType.rows[0]?.definition).toContain("'finalize_paid_pending_binding'");
    expect(eventType.rows[0]?.definition).toContain("'provision_paid_pending_binding'");
    expect(eventType.rows[0]?.definition).toContain("'activate'");
  });
});

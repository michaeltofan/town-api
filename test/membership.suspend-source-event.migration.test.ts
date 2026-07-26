import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { requireDatabaseUrl, resetAndMigrate } from './helpers/pg.js';

describe('membership source-event migration 0018', () => {
  const databaseUrl = requireDatabaseUrl();
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 1 });
    await resetAndMigrate(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('accepts suspend as a membership source-event type', async () => {
    const eventId = '10000000-0000-4000-8000-000000000018';
    const now = '2026-07-26T19:20:00.000Z';

    await pool.query('BEGIN');
    try {
      await pool.query(
        `INSERT INTO town.membership_source_events (
           id, source, source_event_id, event_type, account_id, payload_hash,
           effective_at, processed_at, result, created_at
         ) VALUES ($1, 'test_fixture', 'test:suspend:vocabulary', 'suspend', NULL, $2, $3, $3, 'applied', $3)`,
        [eventId, 'a'.repeat(64), now],
      );
      const persisted = await pool.query<{ event_type: string }>(
        `SELECT event_type FROM town.membership_source_events WHERE id = $1`,
        [eventId],
      );
      expect(persisted.rows[0]?.event_type).toBe('suspend');
    } finally {
      await pool.query('ROLLBACK');
    }
  });
});

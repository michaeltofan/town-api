import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { requireDatabaseUrl, resetAndMigrate } from './helpers/pg.js';

describe('signal discussion session migration', () => {
  const databaseUrl = requireDatabaseUrl();
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 1 });
    await resetAndMigrate(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('creates discussion session tables with intent check and session ordering index', async () => {
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'town'
         AND table_name IN (
           'signal_discussion_sessions',
           'signal_discussion_contributions'
         )
       ORDER BY table_name`,
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      'signal_discussion_contributions',
      'signal_discussion_sessions',
    ]);

    const constraints = await pool.query<{ conname: string }>(
      `SELECT conname
       FROM pg_constraint
       WHERE connamespace = 'town'::regnamespace
         AND conname LIKE 'signal_discussion_%'
       ORDER BY conname`,
    );
    const names = constraints.rows.map((row) => row.conname);
    expect(names).toEqual(
      expect.arrayContaining([
        'signal_discussion_sessions_pkey',
        'signal_discussion_sessions_signal_id_unique',
        'signal_discussion_sessions_signal_id_fkey',
        'signal_discussion_contributions_pkey',
        'signal_discussion_contributions_session_id_fkey',
        'signal_discussion_contributions_signal_id_fkey',
        'signal_discussion_contributions_actor_id_fkey',
        'signal_discussion_contributions_intent_valid',
      ]),
    );

    const indexes = await pool.query<{ indexname: string }>(
      `SELECT indexname
       FROM pg_indexes
       WHERE schemaname = 'town'
         AND indexname = 'signal_discussion_contributions_session_created_at_idx'`,
    );
    expect(indexes.rows).toHaveLength(1);

    const intentCheck = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE connamespace = 'town'::regnamespace
         AND conname = 'signal_discussion_contributions_intent_valid'`,
    );
    expect(intentCheck.rows[0]?.definition.toLowerCase()).toContain('observation');
    expect(intentCheck.rows[0]?.definition.toLowerCase()).toContain('proposal');
    expect(intentCheck.rows[0]?.definition.toLowerCase()).toContain('next_step');
    expect(intentCheck.rows[0]?.definition.toLowerCase()).not.toContain('chat');
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { count, eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { createDatabase, type Database } from '../src/db/client.js';
import {
  ensureSignalConfirmation,
  findConfirmationByActorAndSignal,
} from '../src/db/repositories/confirmations.js';
import { actors, signalConfirmations } from '../src/db/schema.js';
import { CONTROLLED_TEST_ACTOR_ID } from '../src/db/seeds/controlled-actor-content.js';
import {
  FOUNDATION_COMMUNITY_IDS,
  FOUNDATION_SIGNAL_IDS,
} from '../src/db/seeds/foundation-content.js';
import { AppError } from '../src/errors/app-error.js';
import { requireDatabaseUrl, resetMigrateSeedFoundationAndActor } from './helpers/pg.js';

describe('confirmation repository', () => {
  const databaseUrl = requireDatabaseUrl();
  let pool: Pool;
  let database: Database;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 1 });
    await resetMigrateSeedFoundationAndActor(pool);
    database = createDatabase({
      connectionString: databaseUrl,
      poolMax: 5,
      connectionTimeoutMs: 3000,
      idleTimeoutMs: 1000,
    });
  });

  afterAll(async () => {
    await database.close();
    await pool.end();
  });

  it('creates confirmation idempotently with stable identity and timestamps', async () => {
    await database.db.delete(signalConfirmations);

    const absent = await findConfirmationByActorAndSignal(
      database.db,
      CONTROLLED_TEST_ACTOR_ID,
      FOUNDATION_SIGNAL_IDS.milanoSignal1,
    );
    expect(absent).toBeNull();

    const first = await ensureSignalConfirmation(
      database.db,
      CONTROLLED_TEST_ACTOR_ID,
      FOUNDATION_SIGNAL_IDS.milanoSignal1,
    );
    const second = await ensureSignalConfirmation(
      database.db,
      CONTROLLED_TEST_ACTOR_ID,
      FOUNDATION_SIGNAL_IDS.milanoSignal1,
    );

    expect(second.confirmation.id).toBe(first.confirmation.id);
    expect(second.confirmation.confirmedAt).toBe(first.confirmation.confirmedAt);
    expect(second.confirmation.createdAt).toBe(first.confirmation.createdAt);

    const total = await database.db.select({ value: count() }).from(signalConfirmations);
    expect(total[0]?.value).toBe(1);
  });

  it('concurrent ensure calls create exactly one row', async () => {
    await database.db
      .delete(signalConfirmations)
      .where(eq(signalConfirmations.signalId, FOUNDATION_SIGNAL_IDS.milanoSignal2));

    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        ensureSignalConfirmation(
          database.db,
          CONTROLLED_TEST_ACTOR_ID,
          FOUNDATION_SIGNAL_IDS.milanoSignal2,
        ),
      ),
    );

    const ids = new Set(results.map((result) => result.confirmation.id));
    const confirmedAts = new Set(results.map((result) => result.confirmation.confirmedAt));
    expect(ids.size).toBe(1);
    expect(confirmedAts.size).toBe(1);

    const total = await database.db
      .select({ value: count() })
      .from(signalConfirmations)
      .where(eq(signalConfirmations.signalId, FOUNDATION_SIGNAL_IDS.milanoSignal2));
    expect(total[0]?.value).toBe(1);
  });

  it('fails safely for missing signal, community mismatch, and inactive actor', async () => {
    await expect(
      ensureSignalConfirmation(
        database.db,
        CONTROLLED_TEST_ACTOR_ID,
        '00000000-0000-4000-8000-000000000999',
      ),
    ).rejects.toMatchObject({ code: 'SIGNAL_NOT_FOUND' } satisfies Partial<AppError>);

    await expect(
      ensureSignalConfirmation(
        database.db,
        CONTROLLED_TEST_ACTOR_ID,
        FOUNDATION_SIGNAL_IDS.munichSignal1,
      ),
    ).rejects.toMatchObject({
      code: 'ACTOR_NOT_ELIGIBLE_FOR_COMMUNITY',
      statusCode: 403,
    } satisfies Partial<AppError>);

    await pool.query(`ALTER TABLE town.actors DROP CONSTRAINT actors_status_active`);
    await pool.query(`UPDATE town.actors SET status = 'inactive' WHERE id = $1`, [
      CONTROLLED_TEST_ACTOR_ID,
    ]);

    await expect(
      ensureSignalConfirmation(
        database.db,
        CONTROLLED_TEST_ACTOR_ID,
        FOUNDATION_SIGNAL_IDS.milanoSignal3,
      ),
    ).rejects.toThrow(/Controlled confirmation setup is invalid/);

    await pool.query(`UPDATE town.actors SET status = 'active' WHERE id = $1`, [
      CONTROLLED_TEST_ACTOR_ID,
    ]);
    await pool.query(
      `ALTER TABLE town.actors ADD CONSTRAINT actors_status_active CHECK (status = 'active')`,
    );

    await pool.query(
      `ALTER TABLE town.signals DROP CONSTRAINT signals_publication_status_published`,
    );
    await pool.query(
      `INSERT INTO town.signals (
        id, community_id, slug, position, locale, category, area, headline, summary,
        description, why_it_matters, who_is_affected, latest_update, status_label, status_note,
        observed_label, observed_on, observed_precision, author_display_name, image_key,
        image_focus_x, image_focus_y, publication_status, published_at, created_at, updated_at
      ) SELECT
        '00000000-0000-4000-8000-000000000198',
        $1, 'milano-unpublished', 99, locale, category, area, headline, summary,
        description, why_it_matters, who_is_affected, latest_update, status_label, status_note,
        observed_label, observed_on, observed_precision, author_display_name, image_key,
        image_focus_x, image_focus_y, 'draft', published_at, created_at, updated_at
      FROM town.signals WHERE id = $2`,
      [FOUNDATION_COMMUNITY_IDS.milanoIt, FOUNDATION_SIGNAL_IDS.milanoSignal1],
    );

    await expect(
      ensureSignalConfirmation(
        database.db,
        CONTROLLED_TEST_ACTOR_ID,
        '00000000-0000-4000-8000-000000000198',
      ),
    ).rejects.toMatchObject({ code: 'SIGNAL_NOT_FOUND' } satisfies Partial<AppError>);

    // Test-only cleanup of the deliberately invalid draft signal and its immutable ledger.
    await pool.query(`SET session_replication_role = 'replica'`);
    try {
      await pool.query(
        `DELETE FROM town.civic_process_events
         WHERE process_id IN (SELECT id FROM town.civic_processes WHERE signal_id = $1)`,
        ['00000000-0000-4000-8000-000000000198'],
      );
      await pool.query(`DELETE FROM town.civic_processes WHERE signal_id = $1`, [
        '00000000-0000-4000-8000-000000000198',
      ]);
      await pool.query(`DELETE FROM town.signals WHERE id = $1`, [
        '00000000-0000-4000-8000-000000000198',
      ]);
    } finally {
      await pool.query(`SET session_replication_role = 'origin'`);
    }
    await pool.query(
      `ALTER TABLE town.signals ADD CONSTRAINT signals_publication_status_published CHECK (publication_status = 'published')`,
    );
  });

  it('lookup after database client recreation returns the same confirmation', async () => {
    await database.db
      .delete(signalConfirmations)
      .where(eq(signalConfirmations.signalId, FOUNDATION_SIGNAL_IDS.milanoSignal3));

    const created = await ensureSignalConfirmation(
      database.db,
      CONTROLLED_TEST_ACTOR_ID,
      FOUNDATION_SIGNAL_IDS.milanoSignal3,
    );

    await database.close();
    database = createDatabase({
      connectionString: databaseUrl,
      poolMax: 5,
      connectionTimeoutMs: 3000,
      idleTimeoutMs: 1000,
    });

    const found = await findConfirmationByActorAndSignal(
      database.db,
      CONTROLLED_TEST_ACTOR_ID,
      FOUNDATION_SIGNAL_IDS.milanoSignal3,
    );

    expect(found?.id).toBe(created.confirmation.id);
    expect(found?.confirmedAt).toBe(created.confirmation.confirmedAt);
    expect(found?.createdAt).toBe(created.confirmation.createdAt);

    const actor = await database.db
      .select()
      .from(actors)
      .where(eq(actors.id, CONTROLLED_TEST_ACTOR_ID));
    expect(actor).toHaveLength(1);
  });
});

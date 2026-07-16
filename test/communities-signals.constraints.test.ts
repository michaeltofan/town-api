import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  FOUNDATION_COMMUNITY_IDS,
  FOUNDATION_SIGNAL_IDS,
} from '../src/db/seeds/foundation-content.js';
import { requireDatabaseUrl, resetMigrateAndSeed } from './helpers/pg.js';

describe('communities and signals constraints', () => {
  const databaseUrl = requireDatabaseUrl();
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 1 });
    await resetMigrateAndSeed(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('rejects duplicate community slug and position', async () => {
    await expect(
      pool.query(
        `INSERT INTO town.communities (
          id, slug, position, country_code, city_name, display_name, default_locale, timezone, status, created_at, updated_at
        ) VALUES (
          '00000000-0000-4000-8000-0000000000aa', 'milano-it', 10, 'IT', 'X', 'X', 'it-IT', 'Europe/Rome', 'active',
          '2026-07-01T08:00:00.000Z', '2026-07-01T08:00:00.000Z'
        )`,
      ),
    ).rejects.toThrow(/communities_slug_unique|duplicate key/i);

    await expect(
      pool.query(
        `INSERT INTO town.communities (
          id, slug, position, country_code, city_name, display_name, default_locale, timezone, status, created_at, updated_at
        ) VALUES (
          '00000000-0000-4000-8000-0000000000ab', 'other-city', 1, 'IT', 'X', 'X', 'it-IT', 'Europe/Rome', 'active',
          '2026-07-01T08:00:00.000Z', '2026-07-01T08:00:00.000Z'
        )`,
      ),
    ).rejects.toThrow(/communities_position_unique|duplicate key/i);
  });

  it('rejects invalid country code length and invalid community status', async () => {
    await expect(
      pool.query(
        `INSERT INTO town.communities (
          id, slug, position, country_code, city_name, display_name, default_locale, timezone, status, created_at, updated_at
        ) VALUES (
          '00000000-0000-4000-8000-0000000000ac', 'bad-country', 20, 'ITA', 'X', 'X', 'it-IT', 'Europe/Rome', 'active',
          '2026-07-01T08:00:00.000Z', '2026-07-01T08:00:00.000Z'
        )`,
      ),
    ).rejects.toThrow();

    await expect(
      pool.query(
        `INSERT INTO town.communities (
          id, slug, position, country_code, city_name, display_name, default_locale, timezone, status, created_at, updated_at
        ) VALUES (
          '00000000-0000-4000-8000-0000000000ad', 'inactive-city', 21, 'IT', 'X', 'X', 'it-IT', 'Europe/Rome', 'inactive',
          '2026-07-01T08:00:00.000Z', '2026-07-01T08:00:00.000Z'
        )`,
      ),
    ).rejects.toThrow(/communities_status_active/);
  });

  it('rejects missing community foreign key and duplicate signal keys', async () => {
    await expect(
      pool.query(
        `INSERT INTO town.signals (
          id, community_id, slug, position, locale, category, area, headline, summary, description,
          why_it_matters, who_is_affected, latest_update, status_label, status_note, observed_label,
          observed_on, observed_precision, author_display_name, image_key, image_focus_x, image_focus_y,
          publication_status, published_at, created_at, updated_at
        ) VALUES (
          '00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-000000000099', 'orphan', 1, 'it-IT',
          'C', 'A', 'H', 'S', 'D', 'W', 'A', 'L', 'SL', 'SN', 'OL', null, 'day', 'Author',
          'assets/feed/x.jpg', 50, 50, 'published', '2026-07-14T08:00:00.000Z', '2026-07-14T08:00:00.000Z',
          '2026-07-14T08:00:00.000Z'
        )`,
      ),
    ).rejects.toThrow(/signals_community_id_fkey|foreign key/i);

    await expect(
      pool.query(
        `INSERT INTO town.signals (
          id, community_id, slug, position, locale, category, area, headline, summary, description,
          why_it_matters, who_is_affected, latest_update, status_label, status_note, observed_label,
          observed_on, observed_precision, author_display_name, image_key, image_focus_x, image_focus_y,
          publication_status, published_at, created_at, updated_at
        ) VALUES (
          '00000000-0000-4000-8000-0000000000b2', $1, 'milano-signal-1', 9, 'it-IT',
          'C', 'A', 'H', 'S', 'D', 'W', 'A', 'L', 'SL', 'SN', 'OL', null, 'day', 'Author',
          'assets/feed/x.jpg', 50, 50, 'published', '2026-07-14T08:00:00.000Z', '2026-07-14T08:00:00.000Z',
          '2026-07-14T08:00:00.000Z'
        )`,
        [FOUNDATION_COMMUNITY_IDS.milanoIt],
      ),
    ).rejects.toThrow(/signals_community_slug_unique|duplicate key/i);

    await expect(
      pool.query(
        `INSERT INTO town.signals (
          id, community_id, slug, position, locale, category, area, headline, summary, description,
          why_it_matters, who_is_affected, latest_update, status_label, status_note, observed_label,
          observed_on, observed_precision, author_display_name, image_key, image_focus_x, image_focus_y,
          publication_status, published_at, created_at, updated_at
        ) VALUES (
          '00000000-0000-4000-8000-0000000000b3', $1, 'milano-signal-dup-pos', 1, 'it-IT',
          'C', 'A', 'H', 'S', 'D', 'W', 'A', 'L', 'SL', 'SN', 'OL', null, 'day', 'Author',
          'assets/feed/x.jpg', 50, 50, 'published', '2026-07-14T08:00:00.000Z', '2026-07-14T08:00:00.000Z',
          '2026-07-14T08:00:00.000Z'
        )`,
        [FOUNDATION_COMMUNITY_IDS.milanoIt],
      ),
    ).rejects.toThrow(/signals_community_position_unique|duplicate key/i);
  });

  it('rejects invalid image focus, observed precision, and publication status', async () => {
    await expect(
      pool.query(
        `INSERT INTO town.signals (
          id, community_id, slug, position, locale, category, area, headline, summary, description,
          why_it_matters, who_is_affected, latest_update, status_label, status_note, observed_label,
          observed_on, observed_precision, author_display_name, image_key, image_focus_x, image_focus_y,
          publication_status, published_at, created_at, updated_at
        ) VALUES (
          '00000000-0000-4000-8000-0000000000b4', $1, 'bad-focus', 11, 'it-IT',
          'C', 'A', 'H', 'S', 'D', 'W', 'A', 'L', 'SL', 'SN', 'OL', null, 'day', 'Author',
          'assets/feed/x.jpg', 101, 50, 'published', '2026-07-14T08:00:00.000Z', '2026-07-14T08:00:00.000Z',
          '2026-07-14T08:00:00.000Z'
        )`,
        [FOUNDATION_COMMUNITY_IDS.milanoIt],
      ),
    ).rejects.toThrow(/signals_image_focus_x_range/);

    await expect(
      pool.query(
        `INSERT INTO town.signals (
          id, community_id, slug, position, locale, category, area, headline, summary, description,
          why_it_matters, who_is_affected, latest_update, status_label, status_note, observed_label,
          observed_on, observed_precision, author_display_name, image_key, image_focus_x, image_focus_y,
          publication_status, published_at, created_at, updated_at
        ) VALUES (
          '00000000-0000-4000-8000-0000000000b5', $1, 'bad-precision', 12, 'it-IT',
          'C', 'A', 'H', 'S', 'D', 'W', 'A', 'L', 'SL', 'SN', 'OL', null, 'month', 'Author',
          'assets/feed/x.jpg', 50, 50, 'published', '2026-07-14T08:00:00.000Z', '2026-07-14T08:00:00.000Z',
          '2026-07-14T08:00:00.000Z'
        )`,
        [FOUNDATION_COMMUNITY_IDS.milanoIt],
      ),
    ).rejects.toThrow(/signals_observed_precision_valid/);

    await expect(
      pool.query(
        `INSERT INTO town.signals (
          id, community_id, slug, position, locale, category, area, headline, summary, description,
          why_it_matters, who_is_affected, latest_update, status_label, status_note, observed_label,
          observed_on, observed_precision, author_display_name, image_key, image_focus_x, image_focus_y,
          publication_status, published_at, created_at, updated_at
        ) VALUES (
          '00000000-0000-4000-8000-0000000000b6', $1, 'draft-signal', 13, 'it-IT',
          'C', 'A', 'H', 'S', 'D', 'W', 'A', 'L', 'SL', 'SN', 'OL', null, 'day', 'Author',
          'assets/feed/x.jpg', 50, 50, 'draft', '2026-07-14T08:00:00.000Z', '2026-07-14T08:00:00.000Z',
          '2026-07-14T08:00:00.000Z'
        )`,
        [FOUNDATION_COMMUNITY_IDS.milanoIt],
      ),
    ).rejects.toThrow(/signals_publication_status_published/);
  });

  it('restricts deleting a community that still has signals', async () => {
    await expect(
      pool.query(`DELETE FROM town.communities WHERE id = $1`, [FOUNDATION_COMMUNITY_IDS.milanoIt]),
    ).rejects.toThrow(/signals_community_id_fkey|restrict|violates foreign key/i);

    // Signal still exists after failed delete attempt.
    const signal = await pool.query(`SELECT id FROM town.signals WHERE id = $1`, [
      FOUNDATION_SIGNAL_IDS.milanoSignal1,
    ]);
    expect(signal.rows).toHaveLength(1);
  });
});

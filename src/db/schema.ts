import { sql } from 'drizzle-orm';
import {
  char,
  check,
  date,
  foreignKey,
  index,
  pgSchema,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * TOWN schema namespace and civic foundation tables.
 * Product tables beyond communities/signals remain out of scope.
 */
export const town = pgSchema('town');

export const communities = town.table(
  'communities',
  {
    id: uuid('id').primaryKey(),
    slug: text('slug').notNull(),
    position: smallint('position').notNull(),
    countryCode: char('country_code', { length: 2 }).notNull(),
    cityName: text('city_name').notNull(),
    displayName: text('display_name').notNull(),
    defaultLocale: text('default_locale').notNull(),
    timezone: text('timezone').notNull(),
    status: text('status').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    unique('communities_slug_unique').on(table.slug),
    unique('communities_position_unique').on(table.position),
    check('communities_position_positive', sql`${table.position} > 0`),
    check('communities_country_code_length', sql`char_length(${table.countryCode}) = 2`),
    check('communities_status_active', sql`${table.status} = 'active'`),
  ],
);

export const signals = town.table(
  'signals',
  {
    id: uuid('id').primaryKey(),
    communityId: uuid('community_id').notNull(),
    slug: text('slug').notNull(),
    position: smallint('position').notNull(),
    locale: text('locale').notNull(),
    category: text('category').notNull(),
    area: text('area').notNull(),
    headline: text('headline').notNull(),
    summary: text('summary').notNull(),
    description: text('description').notNull(),
    whyItMatters: text('why_it_matters').notNull(),
    whoIsAffected: text('who_is_affected').notNull(),
    latestUpdate: text('latest_update').notNull(),
    statusLabel: text('status_label').notNull(),
    statusNote: text('status_note').notNull(),
    observedLabel: text('observed_label').notNull(),
    observedOn: date('observed_on', { mode: 'string' }),
    observedPrecision: text('observed_precision').notNull(),
    authorDisplayName: text('author_display_name').notNull(),
    imageKey: text('image_key').notNull(),
    imageFocusX: smallint('image_focus_x').notNull(),
    imageFocusY: smallint('image_focus_y').notNull(),
    publicationStatus: text('publication_status').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'string' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.communityId],
      foreignColumns: [communities.id],
      name: 'signals_community_id_fkey',
    }).onDelete('restrict'),
    unique('signals_community_slug_unique').on(table.communityId, table.slug),
    unique('signals_community_position_unique').on(table.communityId, table.position),
    check('signals_position_positive', sql`${table.position} > 0`),
    check('signals_publication_status_published', sql`${table.publicationStatus} = 'published'`),
    check('signals_observed_precision_valid', sql`${table.observedPrecision} in ('day', 'week')`),
    check(
      'signals_image_focus_x_range',
      sql`${table.imageFocusX} >= 0 and ${table.imageFocusX} <= 100`,
    ),
    check(
      'signals_image_focus_y_range',
      sql`${table.imageFocusY} >= 0 and ${table.imageFocusY} <= 100`,
    ),
    index('signals_community_publication_position_idx').on(
      table.communityId,
      table.publicationStatus,
      table.position,
    ),
  ],
);

export type CommunityRow = typeof communities.$inferSelect;
export type SignalRow = typeof signals.$inferSelect;

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
 * Includes communities, signals, controlled actors, and signal confirmations.
 * Public users, membership, and auth tables remain out of scope.
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

export const actors = town.table(
  'actors',
  {
    id: uuid('id').primaryKey(),
    kind: text('kind').notNull(),
    status: text('status').notNull(),
    displayLabel: text('display_label').notNull(),
    communityId: uuid('community_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.communityId],
      foreignColumns: [communities.id],
      name: 'actors_community_id_fkey',
    }).onDelete('restrict'),
    check('actors_kind_controlled_test', sql`${table.kind} = 'controlled_test'`),
    check('actors_status_active', sql`${table.status} = 'active'`),
  ],
);

export const signalConfirmations = town.table(
  'signal_confirmations',
  {
    id: uuid('id').primaryKey(),
    signalId: uuid('signal_id').notNull(),
    actorId: uuid('actor_id').notNull(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true, mode: 'string' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.signalId],
      foreignColumns: [signals.id],
      name: 'signal_confirmations_signal_id_fkey',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.actorId],
      foreignColumns: [actors.id],
      name: 'signal_confirmations_actor_id_fkey',
    }).onDelete('restrict'),
    unique('signal_confirmations_signal_actor_unique').on(table.signalId, table.actorId),
    index('signal_confirmations_actor_signal_idx').on(table.actorId, table.signalId),
  ],
);

export type CommunityRow = typeof communities.$inferSelect;
export type SignalRow = typeof signals.$inferSelect;
export type ActorRow = typeof actors.$inferSelect;
export type SignalConfirmationRow = typeof signalConfirmations.$inferSelect;

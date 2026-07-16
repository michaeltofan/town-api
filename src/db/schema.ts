import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  customType,
  date,
  foreignKey,
  index,
  jsonb,
  pgSchema,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * TOWN schema namespace: civic foundation tables plus account identity foundation.
 * Membership, payments, sessions, and live authentication remain out of scope.
 */
export const town = pgSchema('town');

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

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

export const accounts = town.table(
  'accounts',
  {
    id: uuid('id').primaryKey(),
    status: text('status').notNull(),
    accountReadyAt: timestamp('account_ready_at', { withTimezone: true, mode: 'string' }),
    suspendedAt: timestamp('suspended_at', { withTimezone: true, mode: 'string' }),
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    check(
      'accounts_status_valid',
      sql`${table.status} in ('pending_email', 'pending_passkey', 'active', 'suspended', 'closed')`,
    ),
    check(
      'accounts_status_timestamps',
      sql`(
        (${table.status} = 'pending_email'
          and ${table.accountReadyAt} is null
          and ${table.suspendedAt} is null
          and ${table.closedAt} is null)
        or (${table.status} = 'pending_passkey'
          and ${table.accountReadyAt} is null
          and ${table.suspendedAt} is null
          and ${table.closedAt} is null)
        or (${table.status} = 'active'
          and ${table.accountReadyAt} is not null
          and ${table.suspendedAt} is null
          and ${table.closedAt} is null)
        or (${table.status} = 'suspended'
          and ${table.accountReadyAt} is not null
          and ${table.suspendedAt} is not null
          and ${table.closedAt} is null)
        or (${table.status} = 'closed'
          and ${table.accountReadyAt} is not null
          and ${table.closedAt} is not null)
      )`,
    ),
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
    accountId: uuid('account_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.communityId],
      foreignColumns: [communities.id],
      name: 'actors_community_id_fkey',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.accountId],
      foreignColumns: [accounts.id],
      name: 'actors_account_id_fkey',
    }).onDelete('restrict'),
    uniqueIndex('actors_account_id_unique')
      .on(table.accountId)
      .where(sql`${table.accountId} is not null`),
    check('actors_kind_valid', sql`${table.kind} in ('controlled_test', 'civic')`),
    check('actors_status_active', sql`${table.status} = 'active'`),
    check(
      'actors_controlled_test_unlinked',
      sql`${table.kind} <> 'controlled_test' or ${table.accountId} is null`,
    ),
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

export const accountEmails = town.table(
  'account_emails',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id').notNull(),
    emailOriginal: text('email_original').notNull(),
    emailNormalized: text('email_normalized').notNull(),
    isPrimary: boolean('is_primary').notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true, mode: 'string' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.accountId],
      foreignColumns: [accounts.id],
      name: 'account_emails_account_id_fkey',
    }).onDelete('restrict'),
    uniqueIndex('account_emails_active_normalized_unique')
      .on(table.emailNormalized)
      .where(sql`${table.revokedAt} is null`),
    uniqueIndex('account_emails_one_active_primary')
      .on(table.accountId)
      .where(sql`${table.isPrimary} = true and ${table.revokedAt} is null`),
    check(
      'account_emails_revoked_not_primary',
      sql`${table.revokedAt} is null or ${table.isPrimary} = false`,
    ),
  ],
);

export const passkeyCredentials = town.table(
  'passkey_credentials',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id').notNull(),
    credentialId: bytea('credential_id').notNull(),
    publicKey: bytea('public_key').notNull(),
    signCount: bigint('sign_count', { mode: 'number' }).notNull(),
    transports: text('transports').array(),
    deviceType: text('device_type'),
    backedUp: boolean('backed_up'),
    aaguid: uuid('aaguid'),
    label: text('label'),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    foreignKey({
      columns: [table.accountId],
      foreignColumns: [accounts.id],
      name: 'passkey_credentials_account_id_fkey',
    }).onDelete('restrict'),
    unique('passkey_credentials_credential_id_unique').on(table.credentialId),
    check('passkey_credentials_sign_count_nonnegative', sql`${table.signCount} >= 0`),
    check(
      'passkey_credentials_label_length',
      sql`${table.label} is null or char_length(${table.label}) <= 128`,
    ),
    check(
      'passkey_credentials_device_type_valid',
      sql`${table.deviceType} is null or ${table.deviceType} in ('platform', 'cross_platform')`,
    ),
    index('passkey_credentials_account_active_idx')
      .on(table.accountId)
      .where(sql`${table.revokedAt} is null`),
  ],
);

export const emailChallenges = town.table(
  'email_challenges',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id'),
    emailNormalized: text('email_normalized').notNull(),
    purpose: text('purpose').notNull(),
    secretHash: bytea('secret_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'string' }),
    attemptCount: smallint('attempt_count').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.accountId],
      foreignColumns: [accounts.id],
      name: 'email_challenges_account_id_fkey',
    }).onDelete('restrict'),
    check(
      'email_challenges_purpose_valid',
      sql`${table.purpose} in ('verify_email', 'recover_account')`,
    ),
    check('email_challenges_attempt_count_nonnegative', sql`${table.attemptCount} >= 0`),
    check('email_challenges_expires_after_created', sql`${table.expiresAt} > ${table.createdAt}`),
  ],
);

export const recoveryGrants = town.table(
  'recovery_grants',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id').notNull(),
    tokenHash: bytea('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.accountId],
      foreignColumns: [accounts.id],
      name: 'recovery_grants_account_id_fkey',
    }).onDelete('restrict'),
    unique('recovery_grants_token_hash_unique').on(table.tokenHash),
    check('recovery_grants_expires_after_created', sql`${table.expiresAt} > ${table.createdAt}`),
  ],
);

export const webauthnChallenges = town.table(
  'webauthn_challenges',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id'),
    purpose: text('purpose').notNull(),
    challengeHash: bytea('challenge_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.accountId],
      foreignColumns: [accounts.id],
      name: 'webauthn_challenges_account_id_fkey',
    }).onDelete('restrict'),
    unique('webauthn_challenges_challenge_hash_unique').on(table.challengeHash),
    check(
      'webauthn_challenges_purpose_valid',
      sql`${table.purpose} in ('register', 'authenticate', 'recover_register')`,
    ),
    check(
      'webauthn_challenges_expires_after_created',
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
  ],
);

export const identitySecurityEvents = town.table(
  'identity_security_events',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id'),
    eventType: text('event_type').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'string' }).notNull(),
    requestId: text('request_id'),
    metadata: jsonb('metadata'),
  },
  (table) => [
    foreignKey({
      columns: [table.accountId],
      foreignColumns: [accounts.id],
      name: 'identity_security_events_account_id_fkey',
    }).onDelete('restrict'),
    check(
      'identity_security_events_type_valid',
      sql`${table.eventType} in (
        'email_verification_requested',
        'email_verified',
        'passkey_registered',
        'passkey_used',
        'passkey_revoked',
        'recovery_requested',
        'recovery_completed',
        'account_suspended',
        'account_closed'
      )`,
    ),
    index('identity_security_events_account_occurred_idx').on(table.accountId, table.occurredAt),
  ],
);

export type CommunityRow = typeof communities.$inferSelect;
export type SignalRow = typeof signals.$inferSelect;
export type ActorRow = typeof actors.$inferSelect;
export type SignalConfirmationRow = typeof signalConfirmations.$inferSelect;
export type AccountRow = typeof accounts.$inferSelect;
export type AccountEmailRow = typeof accountEmails.$inferSelect;
export type PasskeyCredentialRow = typeof passkeyCredentials.$inferSelect;
export type EmailChallengeRow = typeof emailChallenges.$inferSelect;
export type RecoveryGrantRow = typeof recoveryGrants.$inferSelect;
export type WebAuthnChallengeRow = typeof webauthnChallenges.$inferSelect;
export type IdentitySecurityEventRow = typeof identitySecurityEvents.$inferSelect;

export type AccountStatus = 'pending_email' | 'pending_passkey' | 'active' | 'suspended' | 'closed';

export type EmailChallengePurpose = 'verify_email' | 'recover_account';
export type WebAuthnChallengePurpose = 'register' | 'authenticate' | 'recover_register';
export type IdentitySecurityEventType =
  | 'email_verification_requested'
  | 'email_verified'
  | 'passkey_registered'
  | 'passkey_used'
  | 'passkey_revoked'
  | 'recovery_requested'
  | 'recovery_completed'
  | 'account_suspended'
  | 'account_closed';

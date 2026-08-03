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
  integer,
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
 * TOWN schema namespace: civic foundation, account identity, ceremony data, and membership
 * entitlement foundations. Stripe SDK/network integration, payments, JWTs, and local
 * verification runtime remain out of scope.
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
    /**
     * Owner label. Default false. When true, evaluateCivicAccess grants the same
     * participant access as an active membership (membership/payment bypass only;
     * actor and local-eligibility gates still apply). Written by account:mark-owner.
     */
    isOwner: boolean('is_owner').notNull().default(false),
    webauthnUserHandle: bytea('webauthn_user_handle'),
    accountReadyAt: timestamp('account_ready_at', { withTimezone: true, mode: 'string' }),
    recoveryCompletedAt: timestamp('recovery_completed_at', {
      withTimezone: true,
      mode: 'string',
    }),
    suspendedAt: timestamp('suspended_at', { withTimezone: true, mode: 'string' }),
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    check(
      'accounts_status_valid',
      sql`${table.status} in ('pending_email', 'pending_password', 'pending_passkey', 'active', 'suspended', 'closed')`,
    ),
    check(
      'accounts_status_timestamps',
      sql`(
        (${table.status} = 'pending_email'
          and ${table.accountReadyAt} is null
          and ${table.suspendedAt} is null
          and ${table.closedAt} is null)
        or (${table.status} = 'pending_password'
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
    check(
      'accounts_webauthn_user_handle_length',
      sql`${table.webauthnUserHandle} is null or octet_length(${table.webauthnUserHandle}) = 32`,
    ),
    check(
      'accounts_webauthn_user_handle_required_after_setup',
      sql`${table.status} in ('pending_email', 'pending_password', 'pending_passkey') or ${table.webauthnUserHandle} is not null`,
    ),
    uniqueIndex('accounts_webauthn_user_handle_unique')
      .on(table.webauthnUserHandle)
      .where(sql`${table.webauthnUserHandle} is not null`),
  ],
);

/**
 * Platform operator allowlist — separate from community owner (`accounts.is_owner`).
 * Active operators (revoked_at IS NULL) may use `/v1/platform/*` surfaces.
 * Bootstrap via CLI (`account:mark-platform-operator`); role_admin may grant later.
 */
export const platformOperators = town.table(
  'platform_operators',
  {
    accountId: uuid('account_id').primaryKey(),
    role: text('role').notNull(),
    grantedAt: timestamp('granted_at', { withTimezone: true, mode: 'string' }).notNull(),
    grantedByAccountId: uuid('granted_by_account_id'),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'string' }),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.accountId],
      foreignColumns: [accounts.id],
      name: 'platform_operators_account_id_fkey',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.grantedByAccountId],
      foreignColumns: [accounts.id],
      name: 'platform_operators_granted_by_account_id_fkey',
    }).onDelete('restrict'),
    check(
      'platform_operators_role_valid',
      sql`${table.role} in ('viewer', 'investigator', 'moderator', 'account_admin', 'ops_admin', 'role_admin')`,
    ),
    check(
      'platform_operators_revoked_not_before_granted',
      sql`${table.revokedAt} is null or ${table.revokedAt} >= ${table.grantedAt}`,
    ),
    index('platform_operators_active_role_idx')
      .on(table.role)
      .where(sql`${table.revokedAt} is null`),
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
    /**
     * Member-authored signals set both author ids. Foundation editorial rows leave both null.
     * FK to actors/media is enforced in SQL (actors table is declared later in this module).
     */
    authorActorId: uuid('author_actor_id'),
    authorAccountId: uuid('author_account_id'),
    mediaUploadId: uuid('media_upload_id'),
    imageKey: text('image_key').notNull(),
    imageFocusX: smallint('image_focus_x').notNull(),
    imageFocusY: smallint('image_focus_y').notNull(),
    publicationStatus: text('publication_status').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'string' }).notNull(),
    /**
     * Owner moderation hide state. Null means visible. Separate from publication_status
     * (which remains CHECK-constrained to 'published'). Hidden iff hidden_at IS NOT NULL.
     */
    hiddenAt: timestamp('hidden_at', { withTimezone: true, mode: 'string' }),
    hiddenReason: text('hidden_reason'),
    hiddenByAccountId: uuid('hidden_by_account_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.communityId],
      foreignColumns: [communities.id],
      name: 'signals_community_id_fkey',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.hiddenByAccountId],
      foreignColumns: [accounts.id],
      name: 'signals_hidden_by_account_id_fkey',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.authorAccountId],
      foreignColumns: [accounts.id],
      name: 'signals_author_account_id_fkey',
    }).onDelete('restrict'),
    unique('signals_community_slug_unique').on(table.communityId, table.slug),
    unique('signals_community_position_unique').on(table.communityId, table.position),
    unique('signals_id_community_id_unique').on(table.id, table.communityId),
    unique('signals_media_upload_id_unique').on(table.mediaUploadId),
    check('signals_position_positive', sql`${table.position} > 0`),
    check('signals_publication_status_published', sql`${table.publicationStatus} = 'published'`),
    check('signals_observed_precision_valid', sql`${table.observedPrecision} in ('day', 'week')`),
    check(
      'signals_hidden_reason_valid',
      sql`${table.hiddenReason} is null or ${table.hiddenReason} in ('immoral', 'abusive', 'spam', 'off_topic', 'illegal', 'other')`,
    ),
    check(
      'signals_hidden_state_consistent',
      sql`(
        (${table.hiddenAt} is null and ${table.hiddenReason} is null and ${table.hiddenByAccountId} is null)
        or (${table.hiddenAt} is not null and ${table.hiddenReason} is not null and ${table.hiddenByAccountId} is not null)
      )`,
    ),
    check(
      'signals_member_author_pair',
      sql`(
        (${table.authorActorId} is null and ${table.authorAccountId} is null)
        or (${table.authorActorId} is not null and ${table.authorAccountId} is not null)
      )`,
    ),
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

/**
 * Append-only audit of platform-operator actions. Separate from identity_security_events
 * so operator actor identity is first-class without expanding the identity event enum.
 */
export const platformAuditEvents = town.table(
  'platform_audit_events',
  {
    id: uuid('id').primaryKey(),
    operatorAccountId: uuid('operator_account_id').notNull(),
    action: text('action').notNull(),
    targetAccountId: uuid('target_account_id'),
    targetSignalId: uuid('target_signal_id'),
    requestId: text('request_id'),
    metadata: jsonb('metadata'),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.operatorAccountId],
      foreignColumns: [accounts.id],
      name: 'platform_audit_events_operator_account_id_fkey',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.targetAccountId],
      foreignColumns: [accounts.id],
      name: 'platform_audit_events_target_account_id_fkey',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.targetSignalId],
      foreignColumns: [signals.id],
      name: 'platform_audit_events_target_signal_id_fkey',
    }).onDelete('restrict'),
    check(
      'platform_audit_events_action_valid',
      sql`${table.action} in (
        'operator_granted',
        'operator_revoked',
        'operator_role_changed',
        'account_suspended',
        'account_reactivated',
        'signal_hidden',
        'signal_unhidden',
        'status_viewed',
        'account_inspected',
        'audit_inspected',
        'email_inspected',
        'payment_inspected',
        'membership_granted',
        'membership_extended',
        'membership_cancellation_scheduled',
        'submission_rejected',
        'submission_restored',
        'discussion_contribution_hidden',
        'discussion_contribution_unhidden',
        'technical_errors_inspected',
        'uptime_inspected',
        'alerts_inspected',
        'alert_acknowledged',
        'backup_inspected',
        'backup_verified',
        'restore_inspected',
        'restore_drill_attested',
        'investigation_exported'
      )`,
    ),
    index('platform_audit_events_occurred_at_idx').on(table.occurredAt),
    index('platform_audit_events_operator_occurred_idx').on(
      table.operatorAccountId,
      table.occurredAt,
    ),
    index('platform_audit_events_target_account_occurred_idx').on(
      table.targetAccountId,
      table.occurredAt,
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
    communityId: uuid('community_id'),
    accountId: uuid('account_id'),
    localEligibilityVerifiedAt: timestamp('local_eligibility_verified_at', {
      withTimezone: true,
      mode: 'string',
    }),
    /**
     * Explicit personal community self-declaration timestamp.
     * Not technical location/residence verification — never populate
     * local_eligibility_verified_at to represent this declaration.
     */
    communityCommitmentAcceptedAt: timestamp('community_commitment_accepted_at', {
      withTimezone: true,
      mode: 'string',
    }),
    /** Server-controlled commitment copy/version identifier. */
    communityCommitmentVersion: text('community_commitment_version'),
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
    check(
      'actors_controlled_test_requires_community',
      sql`${table.kind} <> 'controlled_test' or ${table.communityId} is not null`,
    ),
    check(
      'actors_community_commitment_pair',
      sql`(
        (${table.communityCommitmentAcceptedAt} is null and ${table.communityCommitmentVersion} is null)
        or (
          ${table.communityCommitmentAcceptedAt} is not null
          and ${table.communityCommitmentVersion} is not null
          and ${table.communityId} is not null
        )
      )`,
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

export const signalSubmissions = town.table(
  'signal_submissions',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id').notNull(),
    actorId: uuid('actor_id').notNull(),
    communityId: uuid('community_id').notNull(),
    headline: text('headline').notNull(),
    body: text('body').notNull(),
    status: text('status').notNull(),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true, mode: 'string' }),
    reviewedByAccountId: uuid('reviewed_by_account_id'),
    reviewReason: text('review_reason'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.accountId],
      foreignColumns: [accounts.id],
      name: 'signal_submissions_account_id_fkey',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.actorId],
      foreignColumns: [actors.id],
      name: 'signal_submissions_actor_id_fkey',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.communityId],
      foreignColumns: [communities.id],
      name: 'signal_submissions_community_id_fkey',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.reviewedByAccountId],
      foreignColumns: [accounts.id],
      name: 'signal_submissions_reviewed_by_account_id_fkey',
    }).onDelete('restrict'),
    check(
      'signal_submissions_status_valid',
      sql`${table.status} in ('pending_review', 'rejected')`,
    ),
    check(
      'signal_submissions_review_reason_valid',
      sql`${table.reviewReason} is null or ${table.reviewReason} in ('immoral', 'abusive', 'spam', 'off_topic', 'illegal', 'other')`,
    ),
    check(
      'signal_submissions_review_state_consistent',
      sql`(
        (${table.status} = 'pending_review'
          and ${table.reviewedAt} is null
          and ${table.reviewedByAccountId} is null
          and ${table.reviewReason} is null)
        or (${table.status} = 'rejected'
          and ${table.reviewedAt} is not null
          and ${table.reviewedByAccountId} is not null
          and ${table.reviewReason} is not null)
      )`,
    ),
    index('signal_submissions_account_created_at_idx').on(table.accountId, table.createdAt),
    index('signal_submissions_status_created_at_idx').on(table.status, table.createdAt),
  ],
);

/**
 * One discussion session per published signal. Civic contributions toward a
 * local solution — not chat, comments, or social threading.
 */
export const signalDiscussionSessions = town.table(
  'signal_discussion_sessions',
  {
    id: uuid('id').primaryKey(),
    signalId: uuid('signal_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.signalId],
      foreignColumns: [signals.id],
      name: 'signal_discussion_sessions_signal_id_fkey',
    }).onDelete('restrict'),
    unique('signal_discussion_sessions_signal_id_unique').on(table.signalId),
  ],
);

/**
 * Pending or attached photos for member-authored civic signals.
 * Bytes live in private object storage; this row is the durable metadata ledger.
 * Keyed by community (signal does not exist yet at upload time).
 */
export const signalMediaUploads = town.table(
  'signal_media_uploads',
  {
    id: uuid('id').primaryKey(),
    communityId: uuid('community_id').notNull(),
    accountId: uuid('account_id').notNull(),
    actorId: uuid('actor_id').notNull(),
    objectKey: text('object_key').notNull(),
    contentType: text('content_type').notNull(),
    kind: text('kind').notNull(),
    byteSize: integer('byte_size').notNull(),
    status: text('status').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.communityId],
      foreignColumns: [communities.id],
      name: 'signal_media_uploads_community_id_fkey',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.accountId],
      foreignColumns: [accounts.id],
      name: 'signal_media_uploads_account_id_fkey',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.actorId],
      foreignColumns: [actors.id],
      name: 'signal_media_uploads_actor_id_fkey',
    }).onDelete('restrict'),
    unique('signal_media_uploads_object_key_unique').on(table.objectKey),
    check('signal_media_uploads_kind_valid', sql`${table.kind} in ('image')`),
    check(
      'signal_media_uploads_status_valid',
      sql`${table.status} in ('pending', 'attached', 'abandoned')`,
    ),
    check(
      'signal_media_uploads_content_type_valid',
      sql`${table.contentType} in ('image/jpeg', 'image/png', 'image/webp')`,
    ),
    check('signal_media_uploads_byte_size_positive', sql`${table.byteSize} > 0`),
    index('signal_media_uploads_account_created_at_idx').on(table.accountId, table.createdAt),
  ],
);

/**
 * Pending or attached media objects for discussion contributions.
 * Bytes live in private object storage; this row is the durable metadata ledger.
 */
export const signalDiscussionMediaUploads = town.table(
  'signal_discussion_media_uploads',
  {
    id: uuid('id').primaryKey(),
    signalId: uuid('signal_id').notNull(),
    accountId: uuid('account_id').notNull(),
    actorId: uuid('actor_id').notNull(),
    objectKey: text('object_key').notNull(),
    contentType: text('content_type').notNull(),
    kind: text('kind').notNull(),
    byteSize: integer('byte_size').notNull(),
    status: text('status').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.signalId],
      foreignColumns: [signals.id],
      name: 'signal_discussion_media_uploads_signal_id_fkey',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.accountId],
      foreignColumns: [accounts.id],
      name: 'signal_discussion_media_uploads_account_id_fkey',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.actorId],
      foreignColumns: [actors.id],
      name: 'signal_discussion_media_uploads_actor_id_fkey',
    }).onDelete('restrict'),
    unique('signal_discussion_media_uploads_object_key_unique').on(table.objectKey),
    check('signal_discussion_media_uploads_kind_valid', sql`${table.kind} in ('image', 'video')`),
    check(
      'signal_discussion_media_uploads_status_valid',
      sql`${table.status} in ('pending', 'attached', 'abandoned')`,
    ),
    check(
      'signal_discussion_media_uploads_content_type_valid',
      sql`${table.contentType} in ('image/jpeg', 'image/png', 'image/webp', 'video/mp4')`,
    ),
    check('signal_discussion_media_uploads_byte_size_positive', sql`${table.byteSize} > 0`),
    index('signal_discussion_media_uploads_account_created_at_idx').on(
      table.accountId,
      table.createdAt,
    ),
  ],
);

export const signalDiscussionContributions = town.table(
  'signal_discussion_contributions',
  {
    id: uuid('id').primaryKey(),
    sessionId: uuid('session_id').notNull(),
    signalId: uuid('signal_id').notNull(),
    actorId: uuid('actor_id').notNull(),
    text: text('text').notNull(),
    intent: text('intent').notNull(),
    mediaUploadId: uuid('media_upload_id'),
    hiddenAt: timestamp('hidden_at', { withTimezone: true, mode: 'string' }),
    hiddenReason: text('hidden_reason'),
    hiddenByAccountId: uuid('hidden_by_account_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.sessionId],
      foreignColumns: [signalDiscussionSessions.id],
      name: 'signal_discussion_contributions_session_id_fkey',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.signalId],
      foreignColumns: [signals.id],
      name: 'signal_discussion_contributions_signal_id_fkey',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.actorId],
      foreignColumns: [actors.id],
      name: 'signal_discussion_contributions_actor_id_fkey',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.mediaUploadId],
      foreignColumns: [signalDiscussionMediaUploads.id],
      name: 'signal_discussion_contributions_media_upload_id_fkey',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.hiddenByAccountId],
      foreignColumns: [accounts.id],
      name: 'signal_discussion_contributions_hidden_by_account_id_fkey',
    }).onDelete('restrict'),
    unique('signal_discussion_contributions_media_upload_id_unique').on(table.mediaUploadId),
    check(
      'signal_discussion_contributions_intent_valid',
      sql`${table.intent} in ('observation', 'proposal', 'next_step')`,
    ),
    check(
      'signal_discussion_contributions_hidden_reason_valid',
      sql`${table.hiddenReason} is null or ${table.hiddenReason} in ('immoral', 'abusive', 'spam', 'off_topic', 'illegal', 'other')`,
    ),
    check(
      'signal_discussion_contributions_hidden_state_consistent',
      sql`(
        (${table.hiddenAt} is null and ${table.hiddenReason} is null and ${table.hiddenByAccountId} is null)
        or (${table.hiddenAt} is not null and ${table.hiddenReason} is not null and ${table.hiddenByAccountId} is not null)
      )`,
    ),
    index('signal_discussion_contributions_session_created_at_idx').on(
      table.sessionId,
      table.createdAt,
    ),
    index('signal_discussion_contributions_hidden_created_at_idx').on(
      table.hiddenAt,
      table.createdAt,
    ),
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
    // Permanent exact ownership: a normalized email may belong to at most
    // one account row forever, including after revocation.
    uniqueIndex('account_emails_normalized_unique').on(table.emailNormalized),
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
    publicId: uuid('public_id').notNull(),
    accountId: uuid('account_id').notNull(),
    credentialId: bytea('credential_id').notNull(),
    publicKey: bytea('public_key').notNull(),
    signCount: bigint('sign_count', { mode: 'number' }).notNull(),
    transports: text('transports').array(),
    deviceType: text('device_type'),
    backedUp: boolean('backed_up'),
    backupEligible: boolean('backup_eligible'),
    aaguid: uuid('aaguid'),
    label: text('label'),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'string' }),
    revocationReason: text('revocation_reason'),
  },
  (table) => [
    foreignKey({
      columns: [table.accountId],
      foreignColumns: [accounts.id],
      name: 'passkey_credentials_account_id_fkey',
    }).onDelete('restrict'),
    unique('passkey_credentials_credential_id_unique').on(table.credentialId),
    unique('passkey_credentials_public_id_unique').on(table.publicId),
    check('passkey_credentials_sign_count_nonnegative', sql`${table.signCount} >= 0`),
    check(
      'passkey_credentials_label_length',
      sql`${table.label} is null or char_length(${table.label}) <= 64`,
    ),
    check(
      'passkey_credentials_device_type_valid',
      sql`${table.deviceType} is null or ${table.deviceType} in ('platform', 'cross_platform')`,
    ),
    check(
      'passkey_credentials_revocation_reason_valid',
      sql`${table.revocationReason} is null or ${table.revocationReason} in ('user_requested')`,
    ),
    index('passkey_credentials_account_active_idx')
      .on(table.accountId)
      .where(sql`${table.revokedAt} is null`),
  ],
);

/**
 * Durable KDF parameter record stored alongside password_hash for future rehash/upgrade.
 * Values must match the algorithm that produced password_hash.
 */
export type PasswordKdfParametersRecord = {
  memoryCost: number;
  timeCost: number;
  parallelism: number;
  version: number;
  outputLen: number;
};

/**
 * Optional additional login credential (Argon2id PHC hash). Passkey remains required.
 * At most one active row per account (partial unique on account_id where revoked_at IS NULL).
 * Initial password setup is gated by PASSWORD_AUTH_ENABLED.
 * Public password sign-in is gated separately by PASSWORD_SIGN_IN_ENABLED.
 */
export const accountPasswordCredentials = town.table(
  'account_password_credentials',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id').notNull(),
    passwordHash: text('password_hash').notNull(),
    algorithm: text('algorithm').notNull(),
    parameters: jsonb('parameters').$type<PasswordKdfParametersRecord>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    foreignKey({
      columns: [table.accountId],
      foreignColumns: [accounts.id],
      name: 'account_password_credentials_account_id_fkey',
    }).onDelete('restrict'),
    check('account_password_credentials_algorithm_valid', sql`${table.algorithm} in ('argon2id')`),
    check(
      'account_password_credentials_password_hash_nonempty',
      sql`char_length(${table.passwordHash}) > 0`,
    ),
    check(
      'account_password_credentials_updated_after_created',
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
    check(
      'account_password_credentials_revoked_not_before_created',
      sql`${table.revokedAt} is null or ${table.revokedAt} >= ${table.createdAt}`,
    ),
    uniqueIndex('account_password_credentials_one_active_per_account')
      .on(table.accountId)
      .where(sql`${table.revokedAt} is null`),
    index('account_password_credentials_account_idx').on(table.accountId),
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
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'string' }),
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
    check(
      'email_challenges_consumed_not_before_created',
      sql`${table.consumedAt} is null or ${table.consumedAt} >= ${table.createdAt}`,
    ),
    check(
      'email_challenges_revoked_not_before_created',
      sql`${table.revokedAt} is null or ${table.revokedAt} >= ${table.createdAt}`,
    ),
    index('email_challenges_active_setup_idx')
      .on(table.accountId, table.emailNormalized, table.purpose)
      .where(
        sql`${table.consumedAt} is null and ${table.revokedAt} is null and ${table.purpose} = 'verify_email'`,
      ),
    index('email_challenges_active_recover_account_idx')
      .on(table.accountId, table.emailNormalized, table.purpose)
      .where(
        sql`${table.consumedAt} is null and ${table.revokedAt} is null and ${table.purpose} = 'recover_account'`,
      ),
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
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'string' }),
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
    check(
      'recovery_grants_revoked_not_before_created',
      sql`${table.revokedAt} is null or ${table.revokedAt} >= ${table.createdAt}`,
    ),
    index('recovery_grants_account_active_idx')
      .on(table.accountId)
      .where(sql`${table.consumedAt} is null and ${table.revokedAt} is null`),
  ],
);

export const webauthnChallenges = town.table(
  'webauthn_challenges',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id'),
    sessionId: uuid('session_id'),
    purpose: text('purpose').notNull(),
    challengeHash: bytea('challenge_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'string' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.accountId],
      foreignColumns: [accounts.id],
      name: 'webauthn_challenges_account_id_fkey',
    }).onDelete('restrict'),
    // session_id FK is enforced in SQL (account_sessions is defined later in this module).
    unique('webauthn_challenges_challenge_hash_unique').on(table.challengeHash),
    check(
      'webauthn_challenges_purpose_valid',
      sql`${table.purpose} in ('register', 'authenticate', 'recover_register', 'manage_passkeys_authenticate', 'manage_passkeys_register')`,
    ),
    check(
      'webauthn_challenges_expires_after_created',
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    check(
      'webauthn_challenges_consumed_not_before_created',
      sql`${table.consumedAt} is null or ${table.consumedAt} >= ${table.createdAt}`,
    ),
    check(
      'webauthn_challenges_revoked_not_before_created',
      sql`${table.revokedAt} is null or ${table.revokedAt} >= ${table.createdAt}`,
    ),
    index('webauthn_challenges_active_register_idx')
      .on(table.accountId, table.purpose)
      .where(
        sql`${table.consumedAt} is null and ${table.revokedAt} is null and ${table.purpose} = 'register'`,
      ),
    index('webauthn_challenges_active_authenticate_idx')
      .on(table.purpose, table.expiresAt)
      .where(
        sql`${table.consumedAt} is null and ${table.revokedAt} is null and ${table.purpose} = 'authenticate'`,
      ),
    index('webauthn_challenges_active_recover_register_idx')
      .on(table.accountId, table.purpose)
      .where(
        sql`${table.consumedAt} is null and ${table.revokedAt} is null and ${table.purpose} = 'recover_register'`,
      ),
    index('webauthn_challenges_active_manage_session_idx')
      .on(table.sessionId, table.purpose)
      .where(
        sql`${table.consumedAt} is null and ${table.revokedAt} is null and ${table.purpose} in ('manage_passkeys_authenticate', 'manage_passkeys_register')`,
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
        'account_closed',
        'authentication_failed',
        'session_created',
        'session_rotated',
        'session_revoked',
        'counter_anomaly_detected',
        'rate_limit_triggered',
        'passkey_registration_failed',
        'account_activated',
        'authentication_succeeded',
        'recovery_email_verified',
        'recovery_registration_failed',
        'passkey_inventory_viewed',
        'passkey_management_changed',
        'passkey_reauthentication_started',
        'passkey_reauthentication_succeeded',
        'passkey_reauthentication_failed',
        'passkey_renamed',
        'membership_created',
        'membership_activated',
        'membership_cancellation_scheduled',
        'membership_reactivated',
        'membership_expired',
        'membership_suspended',
        'membership_restored',
        'membership_paid_pending_binding_provisioned',
        'membership_event_replayed',
        'membership_event_rejected',
        'civic_participation_denied',
        'stripe_checkout_session_created',
        'stripe_customer_linked',
        'stripe_webhook_received',
        'stripe_webhook_verified',
        'stripe_webhook_replayed',
        'stripe_webhook_rejected',
        'stripe_subscription_linked',
        'stripe_invoice_paid',
        'stripe_cancellation_scheduled',
        'stripe_cancellation_removed',
        'stripe_subscription_deleted',
        'stripe_payment_failed',
        'stripe_price_mismatch',
        'signal_hidden',
        'signal_unhidden',
        'password_credential_created',
        'password_credential_changed',
        'password_change_failed'
      )`,
    ),
    index('identity_security_events_account_occurred_idx').on(table.accountId, table.occurredAt),
  ],
);

/**
 * Membership entitlement — separate from account identity. One current entitlement per account.
 * Provider references are reserved for future Stripe integration and must never be exposed publicly.
 */
export const membershipEntitlements = town.table(
  'membership_entitlements',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id').notNull(),
    status: text('status').notNull(),
    accessUntil: timestamp('access_until', { withTimezone: true, mode: 'string' }),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    source: text('source').notNull(),
    sourceCustomerId: text('source_customer_id'),
    sourceSubscriptionId: text('source_subscription_id'),
    activatedAt: timestamp('activated_at', { withTimezone: true, mode: 'string' }),
    cancellationRequestedAt: timestamp('cancellation_requested_at', {
      withTimezone: true,
      mode: 'string',
    }),
    expiredAt: timestamp('expired_at', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
    version: bigint('version', { mode: 'number' }).notNull().default(1),
  },
  (table) => [
    foreignKey({
      columns: [table.accountId],
      foreignColumns: [accounts.id],
      name: 'membership_entitlements_account_id_fkey',
    }).onDelete('restrict'),
    unique('membership_entitlements_account_id_unique').on(table.accountId),
    check(
      'membership_entitlements_status_valid',
      sql`${table.status} in ('inactive', 'active', 'cancelling', 'expired', 'paid_pending_binding', 'suspended')`,
    ),
    check(
      'membership_entitlements_source_valid',
      sql`${table.source} in ('test_fixture', 'stripe', 'google_play', 'admin')`,
    ),
    check('membership_entitlements_version_positive', sql`${table.version} >= 1`),
    check(
      'membership_entitlements_updated_after_created',
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
    check(
      'membership_entitlements_state_invariants',
      sql`(
        (${table.status} = 'inactive'
          and ${table.accessUntil} is null
          and ${table.cancelAtPeriodEnd} = false)
        or (${table.status} = 'active'
          and ${table.accessUntil} is not null
          and ${table.cancelAtPeriodEnd} = false
          and ${table.activatedAt} is not null
          and ${table.expiredAt} is null)
        or (${table.status} = 'cancelling'
          and ${table.accessUntil} is not null
          and ${table.cancelAtPeriodEnd} = true
          and ${table.cancellationRequestedAt} is not null
          and ${table.expiredAt} is null)
        or (${table.status} = 'expired'
          and ${table.accessUntil} is not null
          and ${table.cancelAtPeriodEnd} = false
          and ${table.expiredAt} is not null)
        or (${table.status} = 'paid_pending_binding'
          and ${table.accessUntil} is not null
          and ${table.cancelAtPeriodEnd} = false
          and ${table.activatedAt} is null
          and ${table.cancellationRequestedAt} is null
          and ${table.expiredAt} is null)
        or (${table.status} = 'suspended'
          and ${table.accessUntil} is not null
          and ${table.expiredAt} is null)
      )`,
    ),
    uniqueIndex('membership_entitlements_stripe_subscription_unique')
      .on(table.sourceSubscriptionId)
      .where(sql`${table.source} = 'stripe' and ${table.sourceSubscriptionId} is not null`),
    index('membership_entitlements_status_access_until_idx').on(table.status, table.accessUntil),
  ],
);

/**
 * Membership source-event idempotency ledger. Raw payloads are never stored.
 */
export const membershipSourceEvents = town.table(
  'membership_source_events',
  {
    id: uuid('id').primaryKey(),
    source: text('source').notNull(),
    sourceEventId: text('source_event_id').notNull(),
    eventType: text('event_type').notNull(),
    accountId: uuid('account_id'),
    payloadHash: text('payload_hash').notNull(),
    effectiveAt: timestamp('effective_at', { withTimezone: true, mode: 'string' }).notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true, mode: 'string' }).notNull(),
    result: text('result').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.accountId],
      foreignColumns: [accounts.id],
      name: 'membership_source_events_account_id_fkey',
    }).onDelete('restrict'),
    unique('membership_source_events_source_event_unique').on(table.source, table.sourceEventId),
    check(
      'membership_source_events_source_valid',
      sql`${table.source} in ('test_fixture', 'stripe', 'google_play', 'admin')`,
    ),
    check(
      'membership_source_events_event_type_valid',
      sql`${table.eventType} in ('activate', 'schedule_cancellation', 'expire', 'reactivate', 'provision_paid_pending_binding', 'finalize_paid_pending_binding', 'suspend', 'restore')`,
    ),
    check(
      'membership_source_events_result_valid',
      sql`${table.result} in ('applied', 'replayed', 'rejected', 'stale')`,
    ),
    check(
      'membership_source_events_payload_hash_sha256',
      sql`char_length(${table.payloadHash}) = 64`,
    ),
    index('membership_source_events_account_processed_idx').on(table.accountId, table.processedAt),
  ],
);

/**
 * One Stripe Customer per TOWN account. Provider IDs are never exposed publicly.
 */
export const stripeCustomerLinks = town.table(
  'stripe_customer_links',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id').notNull(),
    stripeCustomerId: text('stripe_customer_id').notNull(),
    billingReference: uuid('billing_reference').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.accountId],
      foreignColumns: [accounts.id],
      name: 'stripe_customer_links_account_id_fkey',
    }).onDelete('restrict'),
    unique('stripe_customer_links_account_id_unique').on(table.accountId),
    unique('stripe_customer_links_stripe_customer_id_unique').on(table.stripeCustomerId),
    unique('stripe_customer_links_billing_reference_unique').on(table.billingReference),
    check(
      'stripe_customer_links_updated_after_created',
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
    index('stripe_customer_links_stripe_customer_id_idx').on(table.stripeCustomerId),
  ],
);

/**
 * Bounded Checkout Session attempt ledger for concurrency and Stripe idempotency keys.
 * Does not store Checkout URLs, raw Stripe payloads, or payment data.
 */
export const stripeCheckoutAttempts = town.table(
  'stripe_checkout_attempts',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id').notNull(),
    stripeCheckoutSessionId: text('stripe_checkout_session_id'),
    status: text('status').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    foreignKey({
      columns: [table.accountId],
      foreignColumns: [accounts.id],
      name: 'stripe_checkout_attempts_account_id_fkey',
    }).onDelete('restrict'),
    uniqueIndex('stripe_checkout_attempts_session_id_unique')
      .on(table.stripeCheckoutSessionId)
      .where(sql`${table.stripeCheckoutSessionId} is not null`),
    check(
      'stripe_checkout_attempts_status_valid',
      sql`${table.status} in ('creating', 'open', 'completed', 'expired', 'failed')`,
    ),
    check(
      'stripe_checkout_attempts_expires_after_created',
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    index('stripe_checkout_attempts_account_created_idx').on(table.accountId, table.createdAt),
  ],
);

/**
 * Google Play purchase correlation for TOWN accounts/entitlements.
 * Purchase tokens remain usable for later Google API reconciliation.
 * Order IDs are intentionally not required and are never used as primary/idempotency keys.
 */
export const googlePlayPurchaseLinks = town.table(
  'google_play_purchase_links',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id').notNull(),
    entitlementId: uuid('entitlement_id').notNull(),
    purchaseToken: text('purchase_token').notNull(),
    packageName: text('package_name').notNull(),
    subscriptionId: text('subscription_id').notNull(),
    expiryTime: timestamp('expiry_time', { withTimezone: true, mode: 'string' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.accountId],
      foreignColumns: [accounts.id],
      name: 'google_play_purchase_links_account_id_fkey',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.entitlementId],
      foreignColumns: [membershipEntitlements.id],
      name: 'google_play_purchase_links_entitlement_id_fkey',
    }).onDelete('restrict'),
    unique('google_play_purchase_links_purchase_token_unique').on(table.purchaseToken),
    check(
      'google_play_purchase_links_updated_after_created',
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
    check(
      'google_play_purchase_links_purchase_token_nonempty',
      sql`char_length(${table.purchaseToken}) > 0`,
    ),
    check(
      'google_play_purchase_links_package_name_nonempty',
      sql`char_length(${table.packageName}) > 0`,
    ),
    check(
      'google_play_purchase_links_subscription_id_nonempty',
      sql`char_length(${table.subscriptionId}) > 0`,
    ),
    index('google_play_purchase_links_account_id_idx').on(table.accountId),
    index('google_play_purchase_links_entitlement_id_idx').on(table.entitlementId),
  ],
);

/**
 * Durable, append-only Google Play RTDN ingress correlation.
 * Processing and membership mutation are intentionally separate from receipt.
 */
export const googlePlayRtdnInbox = town.table(
  'google_play_rtdn_inbox',
  {
    id: uuid('id').primaryKey(),
    pubsubSubscription: text('pubsub_subscription').notNull(),
    messageId: text('message_id').notNull(),
    notificationKind: text('notification_kind').notNull(),
    notificationType: integer('notification_type'),
    purchaseToken: text('purchase_token').notNull(),
    eventTimeMillis: bigint('event_time_millis', { mode: 'bigint' }).notNull(),
    subscriptionId: text('subscription_id'),
    rawPayload: jsonb('raw_payload').notNull(),
    payloadHash: text('payload_hash').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'string' }).notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    unique('google_play_rtdn_inbox_subscription_message_unique').on(
      table.pubsubSubscription,
      table.messageId,
    ),
    check(
      'google_play_rtdn_inbox_pubsub_subscription_nonempty',
      sql`char_length(${table.pubsubSubscription}) > 0`,
    ),
    check('google_play_rtdn_inbox_message_id_nonempty', sql`char_length(${table.messageId}) > 0`),
    check(
      'google_play_rtdn_inbox_purchase_token_nonempty',
      sql`char_length(${table.purchaseToken}) > 0`,
    ),
    check(
      'google_play_rtdn_inbox_notification_kind_valid',
      sql`${table.notificationKind} in ('subscription', 'one_time', 'voided')`,
    ),
    check(
      'google_play_rtdn_inbox_raw_payload_object',
      sql`jsonb_typeof(${table.rawPayload}) = 'object'`,
    ),
    check(
      'google_play_rtdn_inbox_payload_hash_valid',
      sql`${table.payloadHash} ~ '^[0-9a-f]{64}$'`,
    ),
    index('google_play_rtdn_inbox_unprocessed_received_at_idx')
      .on(table.receivedAt)
      .where(sql`${table.processedAt} is null`),
  ],
);

/**
 * Restricted pre-authentication authority after email verification and before first passkey.
 * Not a session: cannot access normal APIs, civic actions, membership, or create sessions alone.
 */
export const setupGrants = town.table(
  'setup_grants',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id').notNull(),
    tokenHash: bytea('token_hash').notNull(),
    purpose: text('purpose').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'string' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.accountId],
      foreignColumns: [accounts.id],
      name: 'setup_grants_account_id_fkey',
    }).onDelete('restrict'),
    unique('setup_grants_token_hash_unique').on(table.tokenHash),
    check(
      'setup_grants_purpose_valid',
      sql`${table.purpose} in ('initial_password_setup', 'initial_passkey_registration')`,
    ),
    check('setup_grants_expires_after_created', sql`${table.expiresAt} > ${table.createdAt}`),
    check(
      'setup_grants_consumed_not_before_created',
      sql`${table.consumedAt} is null or ${table.consumedAt} >= ${table.createdAt}`,
    ),
    check(
      'setup_grants_revoked_not_before_created',
      sql`${table.revokedAt} is null or ${table.revokedAt} >= ${table.createdAt}`,
    ),
    index('setup_grants_account_active_idx')
      .on(table.accountId)
      .where(sql`${table.consumedAt} is null and ${table.revokedAt} is null`),
  ],
);

/**
 * Opaque server-side account sessions for future web/mobile clients.
 * Does not imply membership, payment, local verification, or civic entitlement.
 */
export const accountSessions = town.table(
  'account_sessions',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id').notNull(),
    tokenHash: bytea('token_hash').notNull(),
    clientType: text('client_type').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    authenticatedAt: timestamp('authenticated_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'string' }).notNull(),
    idleExpiresAt: timestamp('idle_expires_at', { withTimezone: true, mode: 'string' }).notNull(),
    absoluteExpiresAt: timestamp('absolute_expires_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'string' }),
    revocationReason: text('revocation_reason'),
    recoveryRecentAt: timestamp('recovery_recent_at', {
      withTimezone: true,
      mode: 'string',
    }),
    authenticatedPasskeyId: uuid('authenticated_passkey_id'),
    freshAuthenticatedAt: timestamp('fresh_authenticated_at', {
      withTimezone: true,
      mode: 'string',
    }),
    securityVersion: smallint('security_version').notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.accountId],
      foreignColumns: [accounts.id],
      name: 'account_sessions_account_id_fkey',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.authenticatedPasskeyId],
      foreignColumns: [passkeyCredentials.id],
      name: 'account_sessions_authenticated_passkey_id_fkey',
    }).onDelete('restrict'),
    unique('account_sessions_token_hash_unique').on(table.tokenHash),
    check('account_sessions_client_type_valid', sql`${table.clientType} in ('web', 'mobile')`),
    check('account_sessions_security_version_positive', sql`${table.securityVersion} >= 1`),
    check(
      'account_sessions_authenticated_after_created',
      sql`${table.authenticatedAt} >= ${table.createdAt}`,
    ),
    check(
      'account_sessions_last_seen_after_created',
      sql`${table.lastSeenAt} >= ${table.createdAt}`,
    ),
    check('account_sessions_idle_after_created', sql`${table.idleExpiresAt} > ${table.createdAt}`),
    check(
      'account_sessions_absolute_after_created',
      sql`${table.absoluteExpiresAt} > ${table.createdAt}`,
    ),
    check(
      'account_sessions_idle_within_absolute',
      sql`${table.idleExpiresAt} <= ${table.absoluteExpiresAt}`,
    ),
    check(
      'account_sessions_revoked_not_before_created',
      sql`${table.revokedAt} is null or ${table.revokedAt} >= ${table.createdAt}`,
    ),
    check(
      'account_sessions_revocation_reason_consistency',
      sql`(
        (${table.revokedAt} is null and ${table.revocationReason} is null)
        or (${table.revokedAt} is not null and ${table.revocationReason} is not null)
      )`,
    ),
    check(
      'account_sessions_revocation_reason_valid',
      sql`${table.revocationReason} is null or ${table.revocationReason} in (
        'logout',
        'logout_all',
        'rotated',
        'account_suspended',
        'account_closed',
        'recovery_completed',
        'credential_compromised',
        'security_version_changed',
        'passkey_added',
        'passkey_revoked',
        'password_changed'
      )`,
    ),
    index('account_sessions_account_active_idx')
      .on(table.accountId)
      .where(sql`${table.revokedAt} is null`),
  ],
);

/**
 * Persistent atomic counters for ceremony-specific abuse controls.
 * Subjects must be pre-hashed; raw email/IP/credential/token values are forbidden.
 */
export const ceremonyRateLimits = town.table(
  'ceremony_rate_limits',
  {
    id: uuid('id').primaryKey(),
    scope: text('scope').notNull(),
    subjectHash: bytea('subject_hash').notNull(),
    windowStartedAt: timestamp('window_started_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    windowExpiresAt: timestamp('window_expires_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    attemptCount: integer('attempt_count').notNull(),
    blockedUntil: timestamp('blocked_until', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    unique('ceremony_rate_limits_bucket_unique').on(
      table.scope,
      table.subjectHash,
      table.windowStartedAt,
    ),
    check(
      'ceremony_rate_limits_scope_valid',
      sql`${table.scope} in (
        'email_verification_request_email',
        'email_verification_request_ip',
        'email_verification_attempt_challenge',
        'email_verification_attempt_email_ip',
        'passkey_options_ip',
        'passkey_options_client',
        'passkey_assertion_credential',
        'passkey_assertion_ip',
        'recovery_request_email',
        'recovery_request_ip',
        'setup_options_grant',
        'setup_verification_grant',
        'recovery_options_grant',
        'recovery_verification_grant',
        'recovery_email_attempt_challenge',
        'recovery_email_attempt_email_ip',
        'passkey_inventory_account',
        'passkey_reauthentication_options_session',
        'passkey_reauthentication_verify_session',
        'passkey_registration_options_session',
        'passkey_registration_verify_session',
        'passkey_rename_account',
        'passkey_revoke_account',
        'membership_inventory_account',
        'billing_checkout_account',
        'billing_portal_account',
        'password_setup_grant',
        'password_sign_in_ip',
        'password_sign_in_email',
        'password_change_account'
      )`,
    ),
    check('ceremony_rate_limits_attempt_count_nonnegative', sql`${table.attemptCount} >= 0`),
    check(
      'ceremony_rate_limits_window_order',
      sql`${table.windowExpiresAt} > ${table.windowStartedAt}`,
    ),
    check(
      'ceremony_rate_limits_updated_after_created',
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
    index('ceremony_rate_limits_active_window_idx').on(
      table.scope,
      table.subjectHash,
      table.windowExpiresAt,
    ),
    index('ceremony_rate_limits_blocked_until_idx')
      .on(table.scope, table.subjectHash, table.blockedUntil)
      .where(sql`${table.blockedUntil} is not null`),
  ],
);

export type CommunityRow = typeof communities.$inferSelect;
export type SignalRow = typeof signals.$inferSelect;
export type ActorRow = typeof actors.$inferSelect;
export type SignalConfirmationRow = typeof signalConfirmations.$inferSelect;
export type SignalSubmissionRow = typeof signalSubmissions.$inferSelect;
export type SignalDiscussionSessionRow = typeof signalDiscussionSessions.$inferSelect;
export type SignalMediaUploadRow = typeof signalMediaUploads.$inferSelect;
export type SignalDiscussionMediaUploadRow = typeof signalDiscussionMediaUploads.$inferSelect;
export type SignalDiscussionContributionRow = typeof signalDiscussionContributions.$inferSelect;
export type AccountRow = typeof accounts.$inferSelect;
export type PlatformOperatorRow = typeof platformOperators.$inferSelect;
export type PlatformAuditEventRow = typeof platformAuditEvents.$inferSelect;
export type AccountEmailRow = typeof accountEmails.$inferSelect;
export type PasskeyCredentialRow = typeof passkeyCredentials.$inferSelect;
export type AccountPasswordCredentialRow = typeof accountPasswordCredentials.$inferSelect;
export type EmailChallengeRow = typeof emailChallenges.$inferSelect;
export type RecoveryGrantRow = typeof recoveryGrants.$inferSelect;
export type WebAuthnChallengeRow = typeof webauthnChallenges.$inferSelect;
export type IdentitySecurityEventRow = typeof identitySecurityEvents.$inferSelect;
export type SetupGrantRow = typeof setupGrants.$inferSelect;
export type AccountSessionRow = typeof accountSessions.$inferSelect;
export type CeremonyRateLimitRow = typeof ceremonyRateLimits.$inferSelect;
export type StripeCustomerLinkRow = typeof stripeCustomerLinks.$inferSelect;
export type StripeCheckoutAttemptRow = typeof stripeCheckoutAttempts.$inferSelect;
export type GooglePlayPurchaseLinkRow = typeof googlePlayPurchaseLinks.$inferSelect;
export type GooglePlayRtdnInboxRow = typeof googlePlayRtdnInbox.$inferSelect;
export type MembershipEntitlementRow = typeof membershipEntitlements.$inferSelect;
export type MembershipSourceEventRow = typeof membershipSourceEvents.$inferSelect;

export type AccountStatus =
  'pending_email' | 'pending_password' | 'pending_passkey' | 'active' | 'suspended' | 'closed';

export type PlatformOperatorRole =
  'viewer' | 'investigator' | 'moderator' | 'account_admin' | 'ops_admin' | 'role_admin';

/**
 * Bounded durable buffer of recent server-side technical errors for platform ops.
 * Stores only sanitized diagnostic fields — never bodies, headers, stacks, or secrets.
 */
export const platformTechnicalErrors = town.table(
  'platform_technical_errors',
  {
    id: uuid('id').primaryKey(),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'string' }).notNull(),
    requestId: text('request_id').notNull(),
    method: text('method'),
    route: text('route'),
    statusCode: integer('status_code').notNull(),
    errorCode: text('error_code').notNull(),
    errorName: text('error_name'),
    message: text('message').notNull(),
    environment: text('environment').notNull(),
    service: text('service').notNull(),
    version: text('version').notNull(),
    commitSha: text('commit_sha'),
  },
  (table) => [
    check(
      'platform_technical_errors_status_code_server',
      sql`${table.statusCode} >= 500 and ${table.statusCode} <= 599`,
    ),
    check(
      'platform_technical_errors_request_id_nonempty',
      sql`char_length(${table.requestId}) > 0`,
    ),
    check(
      'platform_technical_errors_error_code_nonempty',
      sql`char_length(${table.errorCode}) > 0`,
    ),
    check('platform_technical_errors_message_nonempty', sql`char_length(${table.message}) > 0`),
    check('platform_technical_errors_message_bounded', sql`char_length(${table.message}) <= 240`),
    check(
      'platform_technical_errors_route_bounded',
      sql`${table.route} is null or char_length(${table.route}) <= 160`,
    ),
    check(
      'platform_technical_errors_method_bounded',
      sql`${table.method} is null or char_length(${table.method}) <= 16`,
    ),
    check(
      'platform_technical_errors_error_name_bounded',
      sql`${table.errorName} is null or char_length(${table.errorName}) <= 80`,
    ),
    index('platform_technical_errors_occurred_at_idx').on(table.occurredAt),
  ],
);

/**
 * Bounded opportunistic uptime samples from operator status checks.
 * Stores component statuses only — no probe secrets or provider payloads.
 */
export const platformUptimeSamples = town.table(
  'platform_uptime_samples',
  {
    id: uuid('id').primaryKey(),
    sampledAt: timestamp('sampled_at', { withTimezone: true, mode: 'string' }).notNull(),
    apiStatus: text('api_status').notNull(),
    databaseStatus: text('database_status').notNull(),
    emailStatus: text('email_status').notNull(),
    stripeStatus: text('stripe_status').notNull(),
    overallStatus: text('overall_status').notNull(),
    environment: text('environment').notNull(),
    service: text('service').notNull(),
    version: text('version').notNull(),
    commitSha: text('commit_sha'),
  },
  (table) => [
    check(
      'platform_uptime_samples_api_status_valid',
      sql`${table.apiStatus} in ('ok', 'degraded', 'fail', 'timeout', 'disabled', 'misconfigured')`,
    ),
    check(
      'platform_uptime_samples_database_status_valid',
      sql`${table.databaseStatus} in ('ok', 'degraded', 'fail', 'timeout', 'disabled', 'misconfigured')`,
    ),
    check(
      'platform_uptime_samples_email_status_valid',
      sql`${table.emailStatus} in ('ok', 'degraded', 'fail', 'timeout', 'disabled', 'misconfigured')`,
    ),
    check(
      'platform_uptime_samples_stripe_status_valid',
      sql`${table.stripeStatus} in ('ok', 'degraded', 'fail', 'timeout', 'disabled', 'misconfigured')`,
    ),
    check(
      'platform_uptime_samples_overall_status_valid',
      sql`${table.overallStatus} in ('ok', 'degraded', 'fail', 'timeout', 'misconfigured')`,
    ),
    index('platform_uptime_samples_sampled_at_idx').on(table.sampledAt),
  ],
);

/**
 * In-console operational alerts for unhealthy components (no email/pager delivery).
 */
export const platformAlerts = town.table(
  'platform_alerts',
  {
    id: uuid('id').primaryKey(),
    openedAt: timestamp('opened_at', { withTimezone: true, mode: 'string' }).notNull(),
    component: text('component').notNull(),
    status: text('status').notNull(),
    severity: text('severity').notNull(),
    detail: text('detail'),
    environment: text('environment').notNull(),
    commitSha: text('commit_sha'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'string' }),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true, mode: 'string' }),
    acknowledgedByAccountId: uuid('acknowledged_by_account_id'),
  },
  (table) => [
    check(
      'platform_alerts_component_valid',
      sql`${table.component} in ('api', 'database', 'email', 'stripe', 'backup', 'restore')`,
    ),
    check(
      'platform_alerts_status_valid',
      sql`${table.status} in ('degraded', 'fail', 'timeout', 'misconfigured')`,
    ),
    check('platform_alerts_severity_valid', sql`${table.severity} in ('warning', 'critical')`),
    check(
      'platform_alerts_detail_bounded',
      sql`${table.detail} is null or char_length(${table.detail}) <= 160`,
    ),
    check(
      'platform_alerts_resolved_not_before_opened',
      sql`${table.resolvedAt} is null or ${table.resolvedAt} >= ${table.openedAt}`,
    ),
    check(
      'platform_alerts_ack_not_before_opened',
      sql`${table.acknowledgedAt} is null or ${table.acknowledgedAt} >= ${table.openedAt}`,
    ),
    check(
      'platform_alerts_ack_consistency',
      sql`(
        (${table.acknowledgedAt} is null and ${table.acknowledgedByAccountId} is null)
        or (${table.acknowledgedAt} is not null and ${table.acknowledgedByAccountId} is not null)
      )`,
    ),
    foreignKey({
      columns: [table.acknowledgedByAccountId],
      foreignColumns: [accounts.id],
      name: 'platform_alerts_acknowledged_by_account_id_fkey',
    }).onDelete('restrict'),
    index('platform_alerts_opened_at_idx').on(table.openedAt),
    index('platform_alerts_open_component_idx')
      .on(table.component)
      .where(sql`${table.resolvedAt} is null`),
  ],
);

export type PlatformAuditAction =
  | 'operator_granted'
  | 'operator_revoked'
  | 'operator_role_changed'
  | 'account_suspended'
  | 'account_reactivated'
  | 'signal_hidden'
  | 'signal_unhidden'
  | 'status_viewed'
  | 'account_inspected'
  | 'audit_inspected'
  | 'email_inspected'
  | 'payment_inspected'
  | 'membership_granted'
  | 'membership_extended'
  | 'membership_cancellation_scheduled'
  | 'submission_rejected'
  | 'submission_restored'
  | 'discussion_contribution_hidden'
  | 'discussion_contribution_unhidden'
  | 'technical_errors_inspected'
  | 'uptime_inspected'
  | 'alerts_inspected'
  | 'alert_acknowledged'
  | 'backup_inspected'
  | 'backup_verified'
  | 'restore_inspected'
  | 'restore_drill_attested'
  | 'investigation_exported';

export type PlatformTechnicalErrorRow = typeof platformTechnicalErrors.$inferSelect;
export type PlatformUptimeSampleRow = typeof platformUptimeSamples.$inferSelect;
export type PlatformAlertRow = typeof platformAlerts.$inferSelect;

/**
 * Operator attestations that platform-managed Postgres PITR backup is active.
 * Does not store dumps, credentials, or restore payloads.
 */
export const platformBackupVerifications = town.table(
  'platform_backup_verifications',
  {
    id: uuid('id').primaryKey(),
    verifiedAt: timestamp('verified_at', { withTimezone: true, mode: 'string' }).notNull(),
    verifiedByAccountId: uuid('verified_by_account_id').notNull(),
    provider: text('provider').notNull(),
    pitrEnabled: boolean('pitr_enabled').notNull(),
    retentionDays: integer('retention_days'),
    note: text('note'),
    environment: text('environment').notNull(),
    commitSha: text('commit_sha'),
  },
  (table) => [
    check(
      'platform_backup_verifications_provider_valid',
      sql`${table.provider} in ('railway_postgres_pitr', 'none')`,
    ),
    check(
      'platform_backup_verifications_retention_positive',
      sql`${table.retentionDays} is null or (${table.retentionDays} >= 1 and ${table.retentionDays} <= 365)`,
    ),
    check(
      'platform_backup_verifications_note_bounded',
      sql`${table.note} is null or char_length(${table.note}) <= 240`,
    ),
    foreignKey({
      columns: [table.verifiedByAccountId],
      foreignColumns: [accounts.id],
      name: 'platform_backup_verifications_verified_by_account_id_fkey',
    }).onDelete('restrict'),
    index('platform_backup_verifications_verified_at_idx').on(table.verifiedAt),
  ],
);

export type PlatformBackupVerificationRow = typeof platformBackupVerifications.$inferSelect;

/**
 * Operator attestations that a restore drill was performed out-of-band
 * (Railway disposable clone / PITR). The API never executes restore.
 */
export const platformRestoreDrillAttestations = town.table(
  'platform_restore_drill_attestations',
  {
    id: uuid('id').primaryKey(),
    drilledAt: timestamp('drilled_at', { withTimezone: true, mode: 'string' }).notNull(),
    drilledByAccountId: uuid('drilled_by_account_id').notNull(),
    method: text('method').notNull(),
    outcome: text('outcome').notNull(),
    restorePointAt: timestamp('restore_point_at', { withTimezone: true, mode: 'string' }),
    note: text('note'),
    environment: text('environment').notNull(),
    commitSha: text('commit_sha'),
  },
  (table) => [
    check(
      'platform_restore_drill_attestations_method_valid',
      sql`${table.method} in ('railway_pitr_disposable_clone', 'railway_pitr_point_in_time')`,
    ),
    check(
      'platform_restore_drill_attestations_outcome_valid',
      sql`${table.outcome} in ('passed', 'failed')`,
    ),
    check(
      'platform_restore_drill_attestations_note_bounded',
      sql`${table.note} is null or char_length(${table.note}) <= 240`,
    ),
    check(
      'platform_restore_drill_attestations_restore_point_not_after_drilled',
      sql`${table.restorePointAt} is null or ${table.restorePointAt} <= ${table.drilledAt}`,
    ),
    foreignKey({
      columns: [table.drilledByAccountId],
      foreignColumns: [accounts.id],
      name: 'platform_restore_drill_attestations_drilled_by_account_id_fkey',
    }).onDelete('restrict'),
    index('platform_restore_drill_attestations_drilled_at_idx').on(table.drilledAt),
  ],
);

export type PlatformRestoreDrillAttestationRow =
  typeof platformRestoreDrillAttestations.$inferSelect;
export type PlatformRestoreDrillMethodValue =
  'railway_pitr_disposable_clone' | 'railway_pitr_point_in_time';
export type PlatformRestoreDrillOutcomeValue = 'passed' | 'failed';

export type PlatformComponentStatusValue =
  'ok' | 'degraded' | 'fail' | 'timeout' | 'disabled' | 'misconfigured';
export type PlatformOverallStatusValue = 'ok' | 'degraded' | 'fail' | 'timeout' | 'misconfigured';
export type PlatformUptimeComponentValue =
  'api' | 'database' | 'email' | 'stripe' | 'backup' | 'restore';
export type PlatformAlertStatusValue = 'degraded' | 'fail' | 'timeout' | 'misconfigured';
export type PlatformAlertSeverityValue = 'warning' | 'critical';
export type PlatformBackupProviderValue = 'railway_postgres_pitr' | 'none';

export type SignalHideReason = 'immoral' | 'abusive' | 'spam' | 'off_topic' | 'illegal' | 'other';

export type EmailChallengePurpose = 'verify_email' | 'recover_account';
export type WebAuthnChallengePurpose =
  | 'register'
  | 'authenticate'
  | 'recover_register'
  | 'manage_passkeys_authenticate'
  | 'manage_passkeys_register';
export type SetupGrantPurpose = 'initial_password_setup' | 'initial_passkey_registration';
export type AccountSessionClientType = 'web' | 'mobile';
export type AccountSessionRevocationReason =
  | 'logout'
  | 'logout_all'
  | 'rotated'
  | 'account_suspended'
  | 'account_closed'
  | 'recovery_completed'
  | 'credential_compromised'
  | 'security_version_changed'
  | 'passkey_added'
  | 'passkey_revoked'
  | 'password_changed';
export type PasskeyRevocationReason = 'user_requested';
export type CeremonyRateLimitScope =
  | 'email_verification_request_email'
  | 'email_verification_request_ip'
  | 'email_verification_attempt_challenge'
  | 'email_verification_attempt_email_ip'
  | 'passkey_options_ip'
  | 'passkey_options_client'
  | 'passkey_assertion_credential'
  | 'passkey_assertion_ip'
  | 'recovery_request_email'
  | 'recovery_request_ip'
  | 'setup_options_grant'
  | 'setup_verification_grant'
  | 'recovery_options_grant'
  | 'recovery_verification_grant'
  | 'recovery_email_attempt_challenge'
  | 'recovery_email_attempt_email_ip'
  | 'passkey_inventory_account'
  | 'passkey_reauthentication_options_session'
  | 'passkey_reauthentication_verify_session'
  | 'passkey_registration_options_session'
  | 'passkey_registration_verify_session'
  | 'passkey_rename_account'
  | 'passkey_revoke_account'
  | 'membership_inventory_account'
  | 'billing_checkout_account'
  | 'billing_portal_account'
  | 'password_setup_grant'
  | 'password_sign_in_ip'
  | 'password_sign_in_email'
  | 'password_change_account';
export type IdentitySecurityEventType =
  | 'email_verification_requested'
  | 'email_verified'
  | 'passkey_registered'
  | 'passkey_used'
  | 'passkey_revoked'
  | 'recovery_requested'
  | 'recovery_completed'
  | 'account_suspended'
  | 'account_closed'
  | 'authentication_failed'
  | 'session_created'
  | 'session_rotated'
  | 'session_revoked'
  | 'counter_anomaly_detected'
  | 'rate_limit_triggered'
  | 'passkey_registration_failed'
  | 'account_activated'
  | 'authentication_succeeded'
  | 'recovery_email_verified'
  | 'recovery_registration_failed'
  | 'passkey_inventory_viewed'
  | 'passkey_management_changed'
  | 'passkey_reauthentication_started'
  | 'passkey_reauthentication_succeeded'
  | 'passkey_reauthentication_failed'
  | 'passkey_renamed'
  | 'membership_created'
  | 'membership_activated'
  | 'membership_cancellation_scheduled'
  | 'membership_reactivated'
  | 'membership_expired'
  | 'membership_suspended'
  | 'membership_restored'
  | 'membership_paid_pending_binding_provisioned'
  | 'membership_event_replayed'
  | 'membership_event_rejected'
  | 'civic_participation_denied'
  | 'stripe_checkout_session_created'
  | 'stripe_customer_linked'
  | 'stripe_webhook_received'
  | 'stripe_webhook_verified'
  | 'stripe_webhook_replayed'
  | 'stripe_webhook_rejected'
  | 'stripe_subscription_linked'
  | 'stripe_invoice_paid'
  | 'stripe_cancellation_scheduled'
  | 'stripe_cancellation_removed'
  | 'stripe_subscription_deleted'
  | 'stripe_payment_failed'
  | 'stripe_price_mismatch'
  | 'signal_hidden'
  | 'signal_unhidden'
  | 'password_credential_created'
  | 'password_credential_changed'
  | 'password_change_failed';

export type MembershipStatus =
  'inactive' | 'active' | 'cancelling' | 'expired' | 'paid_pending_binding' | 'suspended';
export type MembershipSource = 'test_fixture' | 'stripe' | 'google_play' | 'admin';
export type MembershipSourceEventType =
  | 'activate'
  | 'schedule_cancellation'
  | 'expire'
  | 'reactivate'
  | 'provision_paid_pending_binding'
  | 'finalize_paid_pending_binding'
  | 'suspend'
  | 'restore';
export type MembershipSourceEventResult = 'applied' | 'replayed' | 'rejected' | 'stale';
export type CivicAccessLevel = 'visitor' | 'read_only' | 'participant';
export type LocalParticipationEligibility =
  'eligible' | 'not_verified' | 'expired' | 'mismatched_community' | 'unavailable';
export type SignalSubmissionStatus = 'pending_review' | 'rejected';
export type StripeCheckoutAttemptStatus = 'creating' | 'open' | 'completed' | 'expired' | 'failed';

export const civicProcesses = town.table(
  'civic_processes',
  {
    id: uuid('id').primaryKey(),
    signalId: uuid('signal_id').notNull(),
    communityId: uuid('community_id').notNull(),
    currentStage: text('current_stage').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    unique('civic_processes_signal_id_unique').on(table.signalId),
    foreignKey({
      columns: [table.signalId, table.communityId],
      foreignColumns: [signals.id, signals.communityId],
      name: 'civic_processes_signal_community_fkey',
    }).onDelete('restrict'),
    check(
      'civic_processes_stage_supported',
      sql`${table.currentStage} in ('confirmation', 'proposals')`,
    ),
    index('civic_processes_community_created_idx').on(table.communityId, table.createdAt),
  ],
);

export const civicProcessTransitions = town.table(
  'civic_process_transitions',
  {
    id: uuid('id').primaryKey(),
    processId: uuid('process_id').notNull(),
    fromStage: text('from_stage').notNull(),
    toStage: text('to_stage').notNull(),
    reasonKey: text('reason_key').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.processId],
      foreignColumns: [civicProcesses.id],
      name: 'civic_process_transitions_process_id_fkey',
    }).onDelete('restrict'),
    unique('civic_process_transitions_process_path_unique').on(
      table.processId,
      table.fromStage,
      table.toStage,
    ),
    check(
      'civic_process_transitions_confirmation_to_proposals',
      sql`${table.fromStage} = 'confirmation'
        and ${table.toStage} = 'proposals'
        and ${table.reasonKey} = 'confirmation_threshold_reached'`,
    ),
    index('civic_process_transitions_process_occurred_idx').on(table.processId, table.occurredAt),
  ],
);

export const civicProcessEvents = town.table(
  'civic_process_events',
  {
    id: uuid('id').primaryKey(),
    processId: uuid('process_id').notNull(),
    eventType: text('event_type').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.processId],
      foreignColumns: [civicProcesses.id],
      name: 'civic_process_events_process_id_fkey',
    }).onDelete('restrict'),
    check(
      'civic_process_events_type_supported',
      sql`${table.eventType} in ('process_created', 'stage_transitioned_to_proposals')`,
    ),
    unique('civic_process_events_process_type_unique').on(table.processId, table.eventType),
    index('civic_process_events_process_occurred_idx').on(table.processId, table.occurredAt),
  ],
);

export type CivicProcessRow = typeof civicProcesses.$inferSelect;
export type CivicProcessTransitionRow = typeof civicProcessTransitions.$inferSelect;
export type CivicProcessEventRow = typeof civicProcessEvents.$inferSelect;

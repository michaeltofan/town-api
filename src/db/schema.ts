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
    check(
      'accounts_webauthn_user_handle_length',
      sql`${table.webauthnUserHandle} is null or octet_length(${table.webauthnUserHandle}) = 32`,
    ),
    check(
      'accounts_webauthn_user_handle_required_after_setup',
      sql`${table.status} in ('pending_email', 'pending_passkey') or ${table.webauthnUserHandle} is not null`,
    ),
    uniqueIndex('accounts_webauthn_user_handle_unique')
      .on(table.webauthnUserHandle)
      .where(sql`${table.webauthnUserHandle} is not null`),
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
    communityId: uuid('community_id'),
    accountId: uuid('account_id'),
    localEligibilityVerifiedAt: timestamp('local_eligibility_verified_at', {
      withTimezone: true,
      mode: 'string',
    }),
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
    check('signal_submissions_status_valid', sql`${table.status} in ('pending_review')`),
    index('signal_submissions_account_created_at_idx').on(table.accountId, table.createdAt),
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
        'stripe_price_mismatch'
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
      sql`${table.source} in ('test_fixture', 'stripe', 'google_play')`,
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
      sql`${table.source} in ('test_fixture', 'stripe', 'google_play')`,
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
    check('setup_grants_purpose_valid', sql`${table.purpose} in ('initial_passkey_registration')`),
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
        'passkey_revoked'
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
        'billing_portal_account'
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
export type AccountRow = typeof accounts.$inferSelect;
export type AccountEmailRow = typeof accountEmails.$inferSelect;
export type PasskeyCredentialRow = typeof passkeyCredentials.$inferSelect;
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

export type AccountStatus = 'pending_email' | 'pending_passkey' | 'active' | 'suspended' | 'closed';

export type EmailChallengePurpose = 'verify_email' | 'recover_account';
export type WebAuthnChallengePurpose =
  | 'register'
  | 'authenticate'
  | 'recover_register'
  | 'manage_passkeys_authenticate'
  | 'manage_passkeys_register';
export type SetupGrantPurpose = 'initial_passkey_registration';
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
  | 'passkey_revoked';
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
  | 'billing_portal_account';
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
  | 'stripe_price_mismatch';

export type MembershipStatus =
  'inactive' | 'active' | 'cancelling' | 'expired' | 'paid_pending_binding' | 'suspended';
export type MembershipSource = 'test_fixture' | 'stripe' | 'google_play';
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
export type SignalSubmissionStatus = 'pending_review';
export type StripeCheckoutAttemptStatus = 'creating' | 'open' | 'completed' | 'expired' | 'failed';

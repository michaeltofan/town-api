CREATE TABLE "town"."membership_entitlements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"status" text NOT NULL,
	"access_until" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"source" text NOT NULL,
	"source_customer_id" text,
	"source_subscription_id" text,
	"activated_at" timestamp with time zone,
	"cancellation_requested_at" timestamp with time zone,
	"expired_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	CONSTRAINT "membership_entitlements_account_id_unique" UNIQUE("account_id"),
	CONSTRAINT "membership_entitlements_status_valid" CHECK ("town"."membership_entitlements"."status" in ('inactive', 'active', 'cancelling', 'expired')),
	CONSTRAINT "membership_entitlements_source_valid" CHECK ("town"."membership_entitlements"."source" in ('test_fixture', 'stripe')),
	CONSTRAINT "membership_entitlements_version_positive" CHECK ("town"."membership_entitlements"."version" >= 1),
	CONSTRAINT "membership_entitlements_updated_after_created" CHECK ("town"."membership_entitlements"."updated_at" >= "town"."membership_entitlements"."created_at"),
	CONSTRAINT "membership_entitlements_state_invariants" CHECK ((
        ("town"."membership_entitlements"."status" = 'inactive'
          and "town"."membership_entitlements"."access_until" is null
          and "town"."membership_entitlements"."cancel_at_period_end" = false)
        or ("town"."membership_entitlements"."status" = 'active'
          and "town"."membership_entitlements"."access_until" is not null
          and "town"."membership_entitlements"."cancel_at_period_end" = false
          and "town"."membership_entitlements"."activated_at" is not null
          and "town"."membership_entitlements"."expired_at" is null)
        or ("town"."membership_entitlements"."status" = 'cancelling'
          and "town"."membership_entitlements"."access_until" is not null
          and "town"."membership_entitlements"."cancel_at_period_end" = true
          and "town"."membership_entitlements"."cancellation_requested_at" is not null
          and "town"."membership_entitlements"."expired_at" is null)
        or ("town"."membership_entitlements"."status" = 'expired'
          and "town"."membership_entitlements"."access_until" is not null
          and "town"."membership_entitlements"."cancel_at_period_end" = false
          and "town"."membership_entitlements"."expired_at" is not null)
      ))
);
--> statement-breakpoint
CREATE TABLE "town"."membership_source_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"source_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"account_id" uuid,
	"payload_hash" text NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"processed_at" timestamp with time zone NOT NULL,
	"result" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "membership_source_events_source_event_unique" UNIQUE("source","source_event_id"),
	CONSTRAINT "membership_source_events_source_valid" CHECK ("town"."membership_source_events"."source" in ('test_fixture', 'stripe')),
	CONSTRAINT "membership_source_events_event_type_valid" CHECK ("town"."membership_source_events"."event_type" in ('activate', 'schedule_cancellation', 'expire', 'reactivate')),
	CONSTRAINT "membership_source_events_result_valid" CHECK ("town"."membership_source_events"."result" in ('applied', 'replayed', 'rejected', 'stale')),
	CONSTRAINT "membership_source_events_payload_hash_sha256" CHECK (char_length("town"."membership_source_events"."payload_hash") = 64)
);
--> statement-breakpoint
ALTER TABLE "town"."ceremony_rate_limits" DROP CONSTRAINT "ceremony_rate_limits_scope_valid";--> statement-breakpoint
ALTER TABLE "town"."identity_security_events" DROP CONSTRAINT "identity_security_events_type_valid";--> statement-breakpoint
ALTER TABLE "town"."membership_entitlements" ADD CONSTRAINT "membership_entitlements_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "town"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "town"."membership_source_events" ADD CONSTRAINT "membership_source_events_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "town"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "membership_entitlements_stripe_subscription_unique" ON "town"."membership_entitlements" USING btree ("source_subscription_id") WHERE "town"."membership_entitlements"."source" = 'stripe' and "town"."membership_entitlements"."source_subscription_id" is not null;--> statement-breakpoint
CREATE INDEX "membership_entitlements_status_access_until_idx" ON "town"."membership_entitlements" USING btree ("status","access_until");--> statement-breakpoint
CREATE INDEX "membership_source_events_account_processed_idx" ON "town"."membership_source_events" USING btree ("account_id","processed_at");--> statement-breakpoint
ALTER TABLE "town"."ceremony_rate_limits" ADD CONSTRAINT "ceremony_rate_limits_scope_valid" CHECK ("town"."ceremony_rate_limits"."scope" in (
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
        'membership_inventory_account'
      ));--> statement-breakpoint
ALTER TABLE "town"."identity_security_events" ADD CONSTRAINT "identity_security_events_type_valid" CHECK ("town"."identity_security_events"."event_type" in (
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
        'membership_event_replayed',
        'membership_event_rejected',
        'civic_participation_denied'
      ));

CREATE TABLE "town"."google_play_purchase_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"entitlement_id" uuid NOT NULL,
	"purchase_token" text NOT NULL,
	"package_name" text NOT NULL,
	"subscription_id" text NOT NULL,
	"expiry_time" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "google_play_purchase_links_purchase_token_unique" UNIQUE("purchase_token"),
	CONSTRAINT "google_play_purchase_links_updated_after_created" CHECK ("town"."google_play_purchase_links"."updated_at" >= "town"."google_play_purchase_links"."created_at"),
	CONSTRAINT "google_play_purchase_links_purchase_token_nonempty" CHECK (char_length("town"."google_play_purchase_links"."purchase_token") > 0),
	CONSTRAINT "google_play_purchase_links_package_name_nonempty" CHECK (char_length("town"."google_play_purchase_links"."package_name") > 0),
	CONSTRAINT "google_play_purchase_links_subscription_id_nonempty" CHECK (char_length("town"."google_play_purchase_links"."subscription_id") > 0)
);
--> statement-breakpoint
ALTER TABLE "town"."google_play_purchase_links" ADD CONSTRAINT "google_play_purchase_links_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "town"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "town"."google_play_purchase_links" ADD CONSTRAINT "google_play_purchase_links_entitlement_id_fkey" FOREIGN KEY ("entitlement_id") REFERENCES "town"."membership_entitlements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "google_play_purchase_links_account_id_idx" ON "town"."google_play_purchase_links" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "google_play_purchase_links_entitlement_id_idx" ON "town"."google_play_purchase_links" USING btree ("entitlement_id");--> statement-breakpoint
ALTER TABLE "town"."membership_entitlements" DROP CONSTRAINT "membership_entitlements_status_valid";--> statement-breakpoint
ALTER TABLE "town"."membership_entitlements" DROP CONSTRAINT "membership_entitlements_source_valid";--> statement-breakpoint
ALTER TABLE "town"."membership_entitlements" DROP CONSTRAINT "membership_entitlements_state_invariants";--> statement-breakpoint
ALTER TABLE "town"."membership_source_events" DROP CONSTRAINT "membership_source_events_source_valid";--> statement-breakpoint
ALTER TABLE "town"."membership_source_events" DROP CONSTRAINT "membership_source_events_event_type_valid";--> statement-breakpoint
ALTER TABLE "town"."identity_security_events" DROP CONSTRAINT "identity_security_events_type_valid";--> statement-breakpoint
ALTER TABLE "town"."membership_entitlements" ADD CONSTRAINT "membership_entitlements_status_valid" CHECK ("town"."membership_entitlements"."status" in ('inactive', 'active', 'cancelling', 'expired', 'paid_pending_binding'));--> statement-breakpoint
ALTER TABLE "town"."membership_entitlements" ADD CONSTRAINT "membership_entitlements_source_valid" CHECK ("town"."membership_entitlements"."source" in ('test_fixture', 'stripe', 'google_play'));--> statement-breakpoint
ALTER TABLE "town"."membership_entitlements" ADD CONSTRAINT "membership_entitlements_state_invariants" CHECK ((
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
        or ("town"."membership_entitlements"."status" = 'paid_pending_binding'
          and "town"."membership_entitlements"."access_until" is not null
          and "town"."membership_entitlements"."cancel_at_period_end" = false
          and "town"."membership_entitlements"."activated_at" is null
          and "town"."membership_entitlements"."cancellation_requested_at" is null
          and "town"."membership_entitlements"."expired_at" is null)
      ));--> statement-breakpoint
ALTER TABLE "town"."membership_source_events" ADD CONSTRAINT "membership_source_events_source_valid" CHECK ("town"."membership_source_events"."source" in ('test_fixture', 'stripe', 'google_play'));--> statement-breakpoint
ALTER TABLE "town"."membership_source_events" ADD CONSTRAINT "membership_source_events_event_type_valid" CHECK ("town"."membership_source_events"."event_type" in ('activate', 'schedule_cancellation', 'expire', 'reactivate', 'provision_paid_pending_binding'));--> statement-breakpoint
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
      ));

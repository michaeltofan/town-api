CREATE TABLE "town"."stripe_checkout_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"stripe_checkout_session_id" text,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "stripe_checkout_attempts_status_valid" CHECK ("town"."stripe_checkout_attempts"."status" in ('creating', 'open', 'completed', 'expired', 'failed')),
	CONSTRAINT "stripe_checkout_attempts_expires_after_created" CHECK ("town"."stripe_checkout_attempts"."expires_at" > "town"."stripe_checkout_attempts"."created_at")
);
--> statement-breakpoint
CREATE TABLE "town"."stripe_customer_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"billing_reference" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "stripe_customer_links_account_id_unique" UNIQUE("account_id"),
	CONSTRAINT "stripe_customer_links_stripe_customer_id_unique" UNIQUE("stripe_customer_id"),
	CONSTRAINT "stripe_customer_links_billing_reference_unique" UNIQUE("billing_reference"),
	CONSTRAINT "stripe_customer_links_updated_after_created" CHECK ("town"."stripe_customer_links"."updated_at" >= "town"."stripe_customer_links"."created_at")
);
--> statement-breakpoint
ALTER TABLE "town"."ceremony_rate_limits" DROP CONSTRAINT "ceremony_rate_limits_scope_valid";--> statement-breakpoint
ALTER TABLE "town"."identity_security_events" DROP CONSTRAINT "identity_security_events_type_valid";--> statement-breakpoint
ALTER TABLE "town"."stripe_checkout_attempts" ADD CONSTRAINT "stripe_checkout_attempts_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "town"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "town"."stripe_customer_links" ADD CONSTRAINT "stripe_customer_links_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "town"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stripe_checkout_attempts_session_id_unique" ON "town"."stripe_checkout_attempts" USING btree ("stripe_checkout_session_id") WHERE "town"."stripe_checkout_attempts"."stripe_checkout_session_id" is not null;--> statement-breakpoint
CREATE INDEX "stripe_checkout_attempts_account_created_idx" ON "town"."stripe_checkout_attempts" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "stripe_customer_links_stripe_customer_id_idx" ON "town"."stripe_customer_links" USING btree ("stripe_customer_id");--> statement-breakpoint
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
        'membership_inventory_account',
        'billing_checkout_account',
        'billing_portal_account'
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
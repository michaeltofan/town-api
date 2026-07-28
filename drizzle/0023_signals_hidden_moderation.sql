ALTER TABLE "town"."signals" ADD COLUMN "hidden_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "town"."signals" ADD COLUMN "hidden_reason" text;--> statement-breakpoint
ALTER TABLE "town"."signals" ADD COLUMN "hidden_by_account_id" uuid;--> statement-breakpoint
ALTER TABLE "town"."signals" ADD CONSTRAINT "signals_hidden_by_account_id_fkey" FOREIGN KEY ("hidden_by_account_id") REFERENCES "town"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "town"."signals" ADD CONSTRAINT "signals_hidden_reason_valid" CHECK ("town"."signals"."hidden_reason" is null or "town"."signals"."hidden_reason" in ('immoral', 'abusive', 'spam', 'off_topic', 'illegal', 'other'));--> statement-breakpoint
ALTER TABLE "town"."signals" ADD CONSTRAINT "signals_hidden_state_consistent" CHECK (
  ("town"."signals"."hidden_at" is null and "town"."signals"."hidden_reason" is null and "town"."signals"."hidden_by_account_id" is null)
  or ("town"."signals"."hidden_at" is not null and "town"."signals"."hidden_reason" is not null and "town"."signals"."hidden_by_account_id" is not null)
);--> statement-breakpoint
ALTER TABLE "town"."identity_security_events" DROP CONSTRAINT "identity_security_events_type_valid";--> statement-breakpoint
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
        'signal_unhidden'
      ));

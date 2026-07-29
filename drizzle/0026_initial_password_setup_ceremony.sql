ALTER TABLE "town"."accounts" DROP CONSTRAINT "accounts_status_valid";--> statement-breakpoint
ALTER TABLE "town"."accounts" ADD CONSTRAINT "accounts_status_valid" CHECK ("town"."accounts"."status" in ('pending_email', 'pending_password', 'pending_passkey', 'active', 'suspended', 'closed'));--> statement-breakpoint
ALTER TABLE "town"."accounts" DROP CONSTRAINT "accounts_status_timestamps";--> statement-breakpoint
ALTER TABLE "town"."accounts" ADD CONSTRAINT "accounts_status_timestamps" CHECK ((
        ("town"."accounts"."status" = 'pending_email'
          and "town"."accounts"."account_ready_at" is null
          and "town"."accounts"."suspended_at" is null
          and "town"."accounts"."closed_at" is null)
        or ("town"."accounts"."status" = 'pending_password'
          and "town"."accounts"."account_ready_at" is null
          and "town"."accounts"."suspended_at" is null
          and "town"."accounts"."closed_at" is null)
        or ("town"."accounts"."status" = 'pending_passkey'
          and "town"."accounts"."account_ready_at" is null
          and "town"."accounts"."suspended_at" is null
          and "town"."accounts"."closed_at" is null)
        or ("town"."accounts"."status" = 'active'
          and "town"."accounts"."account_ready_at" is not null
          and "town"."accounts"."suspended_at" is null
          and "town"."accounts"."closed_at" is null)
        or ("town"."accounts"."status" = 'suspended'
          and "town"."accounts"."account_ready_at" is not null
          and "town"."accounts"."suspended_at" is not null
          and "town"."accounts"."closed_at" is null)
        or ("town"."accounts"."status" = 'closed'
          and "town"."accounts"."account_ready_at" is not null
          and "town"."accounts"."closed_at" is not null)
      ));--> statement-breakpoint
ALTER TABLE "town"."accounts" DROP CONSTRAINT "accounts_webauthn_user_handle_required_after_setup";--> statement-breakpoint
ALTER TABLE "town"."accounts" ADD CONSTRAINT "accounts_webauthn_user_handle_required_after_setup" CHECK ("town"."accounts"."status" in ('pending_email', 'pending_password', 'pending_passkey') or "town"."accounts"."webauthn_user_handle" is not null);--> statement-breakpoint
ALTER TABLE "town"."setup_grants" DROP CONSTRAINT "setup_grants_purpose_valid";--> statement-breakpoint
ALTER TABLE "town"."setup_grants" ADD CONSTRAINT "setup_grants_purpose_valid" CHECK ("town"."setup_grants"."purpose" in ('initial_password_setup', 'initial_passkey_registration'));--> statement-breakpoint
ALTER TABLE "town"."ceremony_rate_limits" DROP CONSTRAINT "ceremony_rate_limits_scope_valid";--> statement-breakpoint
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
        'billing_portal_account',
        'password_setup_grant'
      ));--> statement-breakpoint
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
        'signal_unhidden',
        'password_credential_created'
      ));

ALTER TABLE "town"."ceremony_rate_limits" DROP CONSTRAINT "ceremony_rate_limits_scope_valid";--> statement-breakpoint
ALTER TABLE "town"."identity_security_events" DROP CONSTRAINT "identity_security_events_type_valid";--> statement-breakpoint
ALTER TABLE "town"."accounts" ADD COLUMN "recovery_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "town"."recovery_grants" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "email_challenges_active_recover_account_idx" ON "town"."email_challenges" USING btree ("account_id","email_normalized","purpose") WHERE "town"."email_challenges"."consumed_at" is null and "town"."email_challenges"."revoked_at" is null and "town"."email_challenges"."purpose" = 'recover_account';--> statement-breakpoint
CREATE INDEX "recovery_grants_account_active_idx" ON "town"."recovery_grants" USING btree ("account_id") WHERE "town"."recovery_grants"."consumed_at" is null and "town"."recovery_grants"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "webauthn_challenges_active_recover_register_idx" ON "town"."webauthn_challenges" USING btree ("account_id","purpose") WHERE "town"."webauthn_challenges"."consumed_at" is null and "town"."webauthn_challenges"."revoked_at" is null and "town"."webauthn_challenges"."purpose" = 'recover_register';--> statement-breakpoint
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
        'recovery_email_attempt_email_ip'
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
        'recovery_registration_failed'
      ));--> statement-breakpoint
ALTER TABLE "town"."recovery_grants" ADD CONSTRAINT "recovery_grants_revoked_not_before_created" CHECK ("town"."recovery_grants"."revoked_at" is null or "town"."recovery_grants"."revoked_at" >= "town"."recovery_grants"."created_at");
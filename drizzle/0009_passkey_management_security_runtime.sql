ALTER TABLE "town"."ceremony_rate_limits" DROP CONSTRAINT "ceremony_rate_limits_scope_valid";--> statement-breakpoint
ALTER TABLE "town"."identity_security_events" DROP CONSTRAINT "identity_security_events_type_valid";--> statement-breakpoint
ALTER TABLE "town"."account_sessions" DROP CONSTRAINT "account_sessions_revocation_reason_valid";--> statement-breakpoint
ALTER TABLE "town"."webauthn_challenges" DROP CONSTRAINT "webauthn_challenges_purpose_valid";--> statement-breakpoint
ALTER TABLE "town"."passkey_credentials" DROP CONSTRAINT "passkey_credentials_label_length";--> statement-breakpoint
ALTER TABLE "town"."passkey_credentials" ADD COLUMN "public_id" uuid;--> statement-breakpoint
UPDATE "town"."passkey_credentials" SET "public_id" = gen_random_uuid() WHERE "public_id" is null;--> statement-breakpoint
ALTER TABLE "town"."passkey_credentials" ALTER COLUMN "public_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "town"."passkey_credentials" ADD CONSTRAINT "passkey_credentials_public_id_unique" UNIQUE("public_id");--> statement-breakpoint
ALTER TABLE "town"."passkey_credentials" ADD COLUMN "revocation_reason" text;--> statement-breakpoint
ALTER TABLE "town"."passkey_credentials" ADD CONSTRAINT "passkey_credentials_label_length" CHECK ("town"."passkey_credentials"."label" is null or char_length("town"."passkey_credentials"."label") <= 64);--> statement-breakpoint
ALTER TABLE "town"."passkey_credentials" ADD CONSTRAINT "passkey_credentials_revocation_reason_valid" CHECK ("town"."passkey_credentials"."revocation_reason" is null or "town"."passkey_credentials"."revocation_reason" in ('user_requested'));--> statement-breakpoint
ALTER TABLE "town"."account_sessions" ADD COLUMN "authenticated_passkey_id" uuid;--> statement-breakpoint
ALTER TABLE "town"."account_sessions" ADD COLUMN "fresh_authenticated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "town"."account_sessions" ADD CONSTRAINT "account_sessions_authenticated_passkey_id_fkey" FOREIGN KEY ("authenticated_passkey_id") REFERENCES "town"."passkey_credentials"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "town"."webauthn_challenges" ADD COLUMN "session_id" uuid;--> statement-breakpoint
ALTER TABLE "town"."webauthn_challenges" ADD CONSTRAINT "webauthn_challenges_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "town"."account_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "town"."webauthn_challenges" ADD CONSTRAINT "webauthn_challenges_purpose_valid" CHECK ("town"."webauthn_challenges"."purpose" in ('register', 'authenticate', 'recover_register', 'manage_passkeys_authenticate', 'manage_passkeys_register'));--> statement-breakpoint
CREATE INDEX "webauthn_challenges_active_manage_session_idx" ON "town"."webauthn_challenges" USING btree ("session_id","purpose") WHERE "town"."webauthn_challenges"."consumed_at" is null and "town"."webauthn_challenges"."revoked_at" is null and "town"."webauthn_challenges"."purpose" in ('manage_passkeys_authenticate', 'manage_passkeys_register');--> statement-breakpoint
ALTER TABLE "town"."account_sessions" ADD CONSTRAINT "account_sessions_revocation_reason_valid" CHECK ("town"."account_sessions"."revocation_reason" is null or "town"."account_sessions"."revocation_reason" in (
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
      ));--> statement-breakpoint
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
        'passkey_revoke_account'
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
        'passkey_renamed'
      ));

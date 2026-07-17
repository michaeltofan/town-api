ALTER TABLE "town"."identity_security_events" DROP CONSTRAINT "identity_security_events_type_valid";--> statement-breakpoint
ALTER TABLE "town"."actors" ALTER COLUMN "community_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "town"."accounts" ADD COLUMN "webauthn_user_handle" "bytea";--> statement-breakpoint
ALTER TABLE "town"."webauthn_challenges" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_webauthn_user_handle_unique" ON "town"."accounts" USING btree ("webauthn_user_handle") WHERE "town"."accounts"."webauthn_user_handle" is not null;--> statement-breakpoint
CREATE INDEX "webauthn_challenges_active_register_idx" ON "town"."webauthn_challenges" USING btree ("account_id","purpose") WHERE "town"."webauthn_challenges"."consumed_at" is null and "town"."webauthn_challenges"."revoked_at" is null and "town"."webauthn_challenges"."purpose" = 'register';--> statement-breakpoint
ALTER TABLE "town"."accounts" ADD CONSTRAINT "accounts_webauthn_user_handle_length" CHECK ("town"."accounts"."webauthn_user_handle" is null or octet_length("town"."accounts"."webauthn_user_handle") = 32);--> statement-breakpoint
ALTER TABLE "town"."accounts" ADD CONSTRAINT "accounts_webauthn_user_handle_required_after_setup" CHECK ("town"."accounts"."status" in ('pending_email', 'pending_passkey') or "town"."accounts"."webauthn_user_handle" is not null);--> statement-breakpoint
ALTER TABLE "town"."actors" ADD CONSTRAINT "actors_controlled_test_requires_community" CHECK ("town"."actors"."kind" <> 'controlled_test' or "town"."actors"."community_id" is not null);--> statement-breakpoint
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
        'account_activated'
      ));--> statement-breakpoint
ALTER TABLE "town"."webauthn_challenges" ADD CONSTRAINT "webauthn_challenges_consumed_not_before_created" CHECK ("town"."webauthn_challenges"."consumed_at" is null or "town"."webauthn_challenges"."consumed_at" >= "town"."webauthn_challenges"."created_at");--> statement-breakpoint
ALTER TABLE "town"."webauthn_challenges" ADD CONSTRAINT "webauthn_challenges_revoked_not_before_created" CHECK ("town"."webauthn_challenges"."revoked_at" is null or "town"."webauthn_challenges"."revoked_at" >= "town"."webauthn_challenges"."created_at");
ALTER TABLE "town"."identity_security_events" DROP CONSTRAINT "identity_security_events_type_valid";--> statement-breakpoint
ALTER TABLE "town"."passkey_credentials" ADD COLUMN "backup_eligible" boolean;--> statement-breakpoint
CREATE INDEX "webauthn_challenges_active_authenticate_idx" ON "town"."webauthn_challenges" USING btree ("purpose","expires_at") WHERE "town"."webauthn_challenges"."consumed_at" is null and "town"."webauthn_challenges"."revoked_at" is null and "town"."webauthn_challenges"."purpose" = 'authenticate';--> statement-breakpoint
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
        'authentication_succeeded'
      ));
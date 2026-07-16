CREATE TABLE "town"."account_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"client_type" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"authenticated_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"idle_expires_at" timestamp with time zone NOT NULL,
	"absolute_expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revocation_reason" text,
	"recovery_recent_at" timestamp with time zone,
	"security_version" smallint NOT NULL,
	CONSTRAINT "account_sessions_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "account_sessions_client_type_valid" CHECK ("town"."account_sessions"."client_type" in ('web', 'mobile')),
	CONSTRAINT "account_sessions_security_version_positive" CHECK ("town"."account_sessions"."security_version" >= 1),
	CONSTRAINT "account_sessions_authenticated_after_created" CHECK ("town"."account_sessions"."authenticated_at" >= "town"."account_sessions"."created_at"),
	CONSTRAINT "account_sessions_last_seen_after_created" CHECK ("town"."account_sessions"."last_seen_at" >= "town"."account_sessions"."created_at"),
	CONSTRAINT "account_sessions_idle_after_created" CHECK ("town"."account_sessions"."idle_expires_at" > "town"."account_sessions"."created_at"),
	CONSTRAINT "account_sessions_absolute_after_created" CHECK ("town"."account_sessions"."absolute_expires_at" > "town"."account_sessions"."created_at"),
	CONSTRAINT "account_sessions_idle_within_absolute" CHECK ("town"."account_sessions"."idle_expires_at" <= "town"."account_sessions"."absolute_expires_at"),
	CONSTRAINT "account_sessions_revoked_not_before_created" CHECK ("town"."account_sessions"."revoked_at" is null or "town"."account_sessions"."revoked_at" >= "town"."account_sessions"."created_at"),
	CONSTRAINT "account_sessions_revocation_reason_consistency" CHECK ((
        ("town"."account_sessions"."revoked_at" is null and "town"."account_sessions"."revocation_reason" is null)
        or ("town"."account_sessions"."revoked_at" is not null and "town"."account_sessions"."revocation_reason" is not null)
      )),
	CONSTRAINT "account_sessions_revocation_reason_valid" CHECK ("town"."account_sessions"."revocation_reason" is null or "town"."account_sessions"."revocation_reason" in (
        'logout',
        'logout_all',
        'rotated',
        'account_suspended',
        'account_closed',
        'recovery_completed',
        'credential_compromised',
        'security_version_changed'
      ))
);
--> statement-breakpoint
CREATE TABLE "town"."ceremony_rate_limits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"subject_hash" "bytea" NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"window_expires_at" timestamp with time zone NOT NULL,
	"attempt_count" integer NOT NULL,
	"blocked_until" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ceremony_rate_limits_bucket_unique" UNIQUE("scope","subject_hash","window_started_at"),
	CONSTRAINT "ceremony_rate_limits_scope_valid" CHECK ("town"."ceremony_rate_limits"."scope" in (
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
        'recovery_verification_grant'
      )),
	CONSTRAINT "ceremony_rate_limits_attempt_count_nonnegative" CHECK ("town"."ceremony_rate_limits"."attempt_count" >= 0),
	CONSTRAINT "ceremony_rate_limits_window_order" CHECK ("town"."ceremony_rate_limits"."window_expires_at" > "town"."ceremony_rate_limits"."window_started_at"),
	CONSTRAINT "ceremony_rate_limits_updated_after_created" CHECK ("town"."ceremony_rate_limits"."updated_at" >= "town"."ceremony_rate_limits"."created_at")
);
--> statement-breakpoint
CREATE TABLE "town"."setup_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"purpose" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "setup_grants_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "setup_grants_purpose_valid" CHECK ("town"."setup_grants"."purpose" in ('initial_passkey_registration')),
	CONSTRAINT "setup_grants_expires_after_created" CHECK ("town"."setup_grants"."expires_at" > "town"."setup_grants"."created_at"),
	CONSTRAINT "setup_grants_consumed_not_before_created" CHECK ("town"."setup_grants"."consumed_at" is null or "town"."setup_grants"."consumed_at" >= "town"."setup_grants"."created_at"),
	CONSTRAINT "setup_grants_revoked_not_before_created" CHECK ("town"."setup_grants"."revoked_at" is null or "town"."setup_grants"."revoked_at" >= "town"."setup_grants"."created_at")
);
--> statement-breakpoint
ALTER TABLE "town"."identity_security_events" DROP CONSTRAINT "identity_security_events_type_valid";--> statement-breakpoint
ALTER TABLE "town"."account_sessions" ADD CONSTRAINT "account_sessions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "town"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "town"."setup_grants" ADD CONSTRAINT "setup_grants_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "town"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_sessions_account_active_idx" ON "town"."account_sessions" USING btree ("account_id") WHERE "town"."account_sessions"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "ceremony_rate_limits_active_window_idx" ON "town"."ceremony_rate_limits" USING btree ("scope","subject_hash","window_expires_at");--> statement-breakpoint
CREATE INDEX "ceremony_rate_limits_blocked_until_idx" ON "town"."ceremony_rate_limits" USING btree ("scope","subject_hash","blocked_until") WHERE "town"."ceremony_rate_limits"."blocked_until" is not null;--> statement-breakpoint
CREATE INDEX "setup_grants_account_active_idx" ON "town"."setup_grants" USING btree ("account_id") WHERE "town"."setup_grants"."consumed_at" is null and "town"."setup_grants"."revoked_at" is null;--> statement-breakpoint
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
        'rate_limit_triggered'
      ));
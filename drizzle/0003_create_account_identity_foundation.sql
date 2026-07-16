CREATE TABLE "town"."account_emails" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"email_original" text NOT NULL,
	"email_normalized" text NOT NULL,
	"is_primary" boolean NOT NULL,
	"verified_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "account_emails_revoked_not_primary" CHECK ("town"."account_emails"."revoked_at" is null or "town"."account_emails"."is_primary" = false)
);
--> statement-breakpoint
CREATE TABLE "town"."accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"account_ready_at" timestamp with time zone,
	"suspended_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "accounts_status_valid" CHECK ("town"."accounts"."status" in ('pending_email', 'pending_passkey', 'active', 'suspended', 'closed')),
	CONSTRAINT "accounts_status_timestamps" CHECK ((
        ("town"."accounts"."status" = 'pending_email'
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
      ))
);
--> statement-breakpoint
CREATE TABLE "town"."email_challenges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid,
	"email_normalized" text NOT NULL,
	"purpose" text NOT NULL,
	"secret_hash" "bytea" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"attempt_count" smallint NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "email_challenges_purpose_valid" CHECK ("town"."email_challenges"."purpose" in ('verify_email', 'recover_account')),
	CONSTRAINT "email_challenges_attempt_count_nonnegative" CHECK ("town"."email_challenges"."attempt_count" >= 0),
	CONSTRAINT "email_challenges_expires_after_created" CHECK ("town"."email_challenges"."expires_at" > "town"."email_challenges"."created_at")
);
--> statement-breakpoint
CREATE TABLE "town"."identity_security_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid,
	"event_type" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"request_id" text,
	"metadata" jsonb,
	CONSTRAINT "identity_security_events_type_valid" CHECK ("town"."identity_security_events"."event_type" in (
        'email_verification_requested',
        'email_verified',
        'passkey_registered',
        'passkey_used',
        'passkey_revoked',
        'recovery_requested',
        'recovery_completed',
        'account_suspended',
        'account_closed'
      ))
);
--> statement-breakpoint
CREATE TABLE "town"."passkey_credentials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"credential_id" "bytea" NOT NULL,
	"public_key" "bytea" NOT NULL,
	"sign_count" bigint NOT NULL,
	"transports" text[],
	"device_type" text,
	"backed_up" boolean,
	"aaguid" uuid,
	"label" text,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "passkey_credentials_credential_id_unique" UNIQUE("credential_id"),
	CONSTRAINT "passkey_credentials_sign_count_nonnegative" CHECK ("town"."passkey_credentials"."sign_count" >= 0),
	CONSTRAINT "passkey_credentials_label_length" CHECK ("town"."passkey_credentials"."label" is null or char_length("town"."passkey_credentials"."label") <= 128),
	CONSTRAINT "passkey_credentials_device_type_valid" CHECK ("town"."passkey_credentials"."device_type" is null or "town"."passkey_credentials"."device_type" in ('platform', 'cross_platform'))
);
--> statement-breakpoint
CREATE TABLE "town"."recovery_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "recovery_grants_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "recovery_grants_expires_after_created" CHECK ("town"."recovery_grants"."expires_at" > "town"."recovery_grants"."created_at")
);
--> statement-breakpoint
CREATE TABLE "town"."webauthn_challenges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid,
	"purpose" text NOT NULL,
	"challenge_hash" "bytea" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "webauthn_challenges_challenge_hash_unique" UNIQUE("challenge_hash"),
	CONSTRAINT "webauthn_challenges_purpose_valid" CHECK ("town"."webauthn_challenges"."purpose" in ('register', 'authenticate', 'recover_register')),
	CONSTRAINT "webauthn_challenges_expires_after_created" CHECK ("town"."webauthn_challenges"."expires_at" > "town"."webauthn_challenges"."created_at")
);
--> statement-breakpoint
ALTER TABLE "town"."actors" DROP CONSTRAINT "actors_kind_controlled_test";--> statement-breakpoint
ALTER TABLE "town"."actors" ADD COLUMN "account_id" uuid;--> statement-breakpoint
ALTER TABLE "town"."account_emails" ADD CONSTRAINT "account_emails_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "town"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "town"."email_challenges" ADD CONSTRAINT "email_challenges_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "town"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "town"."identity_security_events" ADD CONSTRAINT "identity_security_events_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "town"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "town"."passkey_credentials" ADD CONSTRAINT "passkey_credentials_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "town"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "town"."recovery_grants" ADD CONSTRAINT "recovery_grants_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "town"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "town"."webauthn_challenges" ADD CONSTRAINT "webauthn_challenges_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "town"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_emails_active_normalized_unique" ON "town"."account_emails" USING btree ("email_normalized") WHERE "town"."account_emails"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "account_emails_one_active_primary" ON "town"."account_emails" USING btree ("account_id") WHERE "town"."account_emails"."is_primary" = true and "town"."account_emails"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "identity_security_events_account_occurred_idx" ON "town"."identity_security_events" USING btree ("account_id","occurred_at");--> statement-breakpoint
CREATE INDEX "passkey_credentials_account_active_idx" ON "town"."passkey_credentials" USING btree ("account_id") WHERE "town"."passkey_credentials"."revoked_at" is null;--> statement-breakpoint
ALTER TABLE "town"."actors" ADD CONSTRAINT "actors_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "town"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "actors_account_id_unique" ON "town"."actors" USING btree ("account_id") WHERE "town"."actors"."account_id" is not null;--> statement-breakpoint
ALTER TABLE "town"."actors" ADD CONSTRAINT "actors_kind_valid" CHECK ("town"."actors"."kind" in ('controlled_test', 'civic'));--> statement-breakpoint
ALTER TABLE "town"."actors" ADD CONSTRAINT "actors_controlled_test_unlinked" CHECK ("town"."actors"."kind" <> 'controlled_test' or "town"."actors"."account_id" is null);
CREATE TABLE "town"."account_password_credentials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"password_hash" text NOT NULL,
	"algorithm" text NOT NULL,
	"parameters" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "account_password_credentials_algorithm_valid" CHECK ("town"."account_password_credentials"."algorithm" in ('argon2id')),
	CONSTRAINT "account_password_credentials_password_hash_nonempty" CHECK (char_length("town"."account_password_credentials"."password_hash") > 0),
	CONSTRAINT "account_password_credentials_updated_after_created" CHECK ("town"."account_password_credentials"."updated_at" >= "town"."account_password_credentials"."created_at"),
	CONSTRAINT "account_password_credentials_revoked_not_before_created" CHECK ("town"."account_password_credentials"."revoked_at" is null or "town"."account_password_credentials"."revoked_at" >= "town"."account_password_credentials"."created_at")
);
--> statement-breakpoint
ALTER TABLE "town"."account_password_credentials" ADD CONSTRAINT "account_password_credentials_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "town"."accounts"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "account_password_credentials_one_active_per_account" ON "town"."account_password_credentials" USING btree ("account_id") WHERE "revoked_at" is null;
--> statement-breakpoint
CREATE INDEX "account_password_credentials_account_idx" ON "town"."account_password_credentials" USING btree ("account_id");

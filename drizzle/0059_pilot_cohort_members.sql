CREATE TABLE "town"."pilot_cohort_members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"cohort" text NOT NULL,
	"granted_at" timestamp with time zone NOT NULL,
	"granted_by_account_id" uuid NOT NULL,
	"membership_source_event_id" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "pilot_cohort_members_account_cohort_unique" UNIQUE("account_id","cohort"),
	CONSTRAINT "pilot_cohort_members_cohort_valid" CHECK ("town"."pilot_cohort_members"."cohort" in ('madrid_pilot')),
	CONSTRAINT "pilot_cohort_members_revoked_not_before_granted" CHECK ("town"."pilot_cohort_members"."revoked_at" is null or "town"."pilot_cohort_members"."revoked_at" >= "town"."pilot_cohort_members"."granted_at")
);
--> statement-breakpoint
ALTER TABLE "town"."pilot_cohort_members" ADD CONSTRAINT "pilot_cohort_members_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "town"."accounts"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "town"."pilot_cohort_members" ADD CONSTRAINT "pilot_cohort_members_granted_by_account_id_fkey" FOREIGN KEY ("granted_by_account_id") REFERENCES "town"."accounts"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "pilot_cohort_members_cohort_idx" ON "town"."pilot_cohort_members" USING btree ("cohort") WHERE "town"."pilot_cohort_members"."revoked_at" is null;

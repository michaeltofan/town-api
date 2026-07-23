CREATE TABLE "town"."signal_submissions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"community_id" uuid NOT NULL,
	"headline" text NOT NULL,
	"body" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "signal_submissions_status_valid" CHECK ("town"."signal_submissions"."status" in ('pending_review'))
);
--> statement-breakpoint
ALTER TABLE "town"."signal_submissions" ADD CONSTRAINT "signal_submissions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "town"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "town"."signal_submissions" ADD CONSTRAINT "signal_submissions_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "town"."actors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "town"."signal_submissions" ADD CONSTRAINT "signal_submissions_community_id_fkey" FOREIGN KEY ("community_id") REFERENCES "town"."communities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "signal_submissions_account_created_at_idx" ON "town"."signal_submissions" USING btree ("account_id","created_at");
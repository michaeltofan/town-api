CREATE TABLE "town"."actors" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"display_label" text NOT NULL,
	"community_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "actors_kind_controlled_test" CHECK ("town"."actors"."kind" = 'controlled_test'),
	CONSTRAINT "actors_status_active" CHECK ("town"."actors"."status" = 'active')
);
--> statement-breakpoint
CREATE TABLE "town"."signal_confirmations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"signal_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"confirmed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "signal_confirmations_signal_actor_unique" UNIQUE("signal_id","actor_id")
);
--> statement-breakpoint
ALTER TABLE "town"."actors" ADD CONSTRAINT "actors_community_id_fkey" FOREIGN KEY ("community_id") REFERENCES "town"."communities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "town"."signal_confirmations" ADD CONSTRAINT "signal_confirmations_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "town"."signals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "town"."signal_confirmations" ADD CONSTRAINT "signal_confirmations_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "town"."actors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "signal_confirmations_actor_signal_idx" ON "town"."signal_confirmations" USING btree ("actor_id","signal_id");
CREATE TABLE "town"."signal_discussion_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"signal_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "signal_discussion_sessions_signal_id_unique" UNIQUE("signal_id")
);
--> statement-breakpoint
CREATE TABLE "town"."signal_discussion_contributions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"signal_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"text" text NOT NULL,
	"intent" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "signal_discussion_contributions_intent_valid" CHECK ("town"."signal_discussion_contributions"."intent" in ('observation', 'proposal', 'next_step'))
);
--> statement-breakpoint
ALTER TABLE "town"."signal_discussion_sessions" ADD CONSTRAINT "signal_discussion_sessions_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "town"."signals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "town"."signal_discussion_contributions" ADD CONSTRAINT "signal_discussion_contributions_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "town"."signal_discussion_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "town"."signal_discussion_contributions" ADD CONSTRAINT "signal_discussion_contributions_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "town"."signals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "town"."signal_discussion_contributions" ADD CONSTRAINT "signal_discussion_contributions_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "town"."actors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "signal_discussion_contributions_session_created_at_idx" ON "town"."signal_discussion_contributions" USING btree ("session_id","created_at");

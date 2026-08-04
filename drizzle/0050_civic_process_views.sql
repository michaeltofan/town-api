CREATE TABLE "town"."civic_process_views" (
  "id" uuid PRIMARY KEY NOT NULL,
  "actor_id" uuid NOT NULL,
  "process_id" uuid NOT NULL,
  "viewed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "town"."civic_process_views"
  ADD CONSTRAINT "civic_process_views_actor_id_fkey"
  FOREIGN KEY ("actor_id") REFERENCES "town"."actors"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "town"."civic_process_views"
  ADD CONSTRAINT "civic_process_views_process_id_fkey"
  FOREIGN KEY ("process_id") REFERENCES "town"."civic_processes"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "town"."civic_process_views"
  ADD CONSTRAINT "civic_process_views_actor_process_unique"
  UNIQUE ("actor_id", "process_id");
--> statement-breakpoint
CREATE INDEX "civic_process_views_process_id_idx"
  ON "town"."civic_process_views" USING btree ("process_id");

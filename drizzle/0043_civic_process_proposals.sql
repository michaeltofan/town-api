CREATE TABLE "town"."civic_proposals" (
  "id" uuid PRIMARY KEY NOT NULL,
  "process_id" uuid NOT NULL,
  "author_actor_id" uuid NOT NULL,
  "title" text NOT NULL,
  "body" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  CONSTRAINT "civic_proposals_process_actor_unique" UNIQUE("process_id", "author_actor_id"),
  CONSTRAINT "civic_proposals_title_valid" CHECK (char_length(btrim("title")) BETWEEN 1 AND 160),
  CONSTRAINT "civic_proposals_body_valid" CHECK (char_length(btrim("body")) BETWEEN 1 AND 2000)
);
--> statement-breakpoint
ALTER TABLE "town"."civic_proposals"
  ADD CONSTRAINT "civic_proposals_process_id_fkey"
  FOREIGN KEY ("process_id") REFERENCES "town"."civic_processes"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "town"."civic_proposals"
  ADD CONSTRAINT "civic_proposals_author_actor_id_fkey"
  FOREIGN KEY ("author_actor_id") REFERENCES "town"."actors"("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "civic_proposals_process_created_idx"
  ON "town"."civic_proposals" USING btree ("process_id", "created_at", "id");
--> statement-breakpoint
CREATE FUNCTION "town"."guard_civic_proposal_insert"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  process_stage text;
  process_community_id uuid;
  actor_community_id uuid;
  actor_status text;
BEGIN
  SELECT "current_stage", "community_id"
  INTO process_stage, process_community_id
  FROM "town"."civic_processes"
  WHERE "id" = NEW."process_id"
  FOR SHARE;

  IF process_stage IS DISTINCT FROM 'proposals' THEN
    RAISE EXCEPTION 'civic proposal stage is closed';
  END IF;

  SELECT "community_id", "status"
  INTO actor_community_id, actor_status
  FROM "town"."actors"
  WHERE "id" = NEW."author_actor_id";

  IF actor_status IS DISTINCT FROM 'active'
     OR actor_community_id IS DISTINCT FROM process_community_id THEN
    RAISE EXCEPTION 'civic proposal actor is not eligible for process community';
  END IF;

  NEW."title" := btrim(NEW."title");
  NEW."body" := btrim(NEW."body");
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "civic_proposals_guard_insert"
BEFORE INSERT ON "town"."civic_proposals"
FOR EACH ROW EXECUTE FUNCTION "town"."guard_civic_proposal_insert"();

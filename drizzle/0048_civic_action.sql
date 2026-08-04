ALTER TABLE "town"."civic_processes"
  DROP CONSTRAINT "civic_processes_stage_supported";
--> statement-breakpoint
ALTER TABLE "town"."civic_processes"
  ADD CONSTRAINT "civic_processes_stage_supported"
  CHECK (
    "current_stage" IN (
      'confirmation', 'proposals', 'deliberation', 'ballot_preparation', 'voting', 'mandate', 'action'
    )
  );
--> statement-breakpoint
ALTER TABLE "town"."civic_process_events"
  DROP CONSTRAINT "civic_process_events_type_supported";
--> statement-breakpoint
ALTER TABLE "town"."civic_process_events"
  ADD CONSTRAINT "civic_process_events_type_supported"
  CHECK (
    "event_type" IN (
      'process_created',
      'stage_transitioned_to_proposals',
      'stage_transitioned_to_deliberation',
      'stage_transitioned_to_ballot_preparation',
      'stage_transitioned_to_voting',
      'stage_transitioned_to_mandate',
      'stage_transitioned_to_action'
    )
  );
--> statement-breakpoint
ALTER TABLE "town"."civic_process_transitions"
  DROP CONSTRAINT "civic_process_transitions_supported_paths";
--> statement-breakpoint
ALTER TABLE "town"."civic_process_transitions"
  ADD CONSTRAINT "civic_process_transitions_supported_paths"
  CHECK (
    (
      "from_stage" = 'confirmation'
      AND "to_stage" = 'proposals'
      AND "reason_key" = 'confirmation_threshold_reached'
    )
    OR (
      "from_stage" = 'proposals'
      AND "to_stage" = 'deliberation'
      AND "reason_key" = 'proposal_threshold_reached'
    )
    OR (
      "from_stage" = 'deliberation'
      AND "to_stage" = 'ballot_preparation'
      AND "reason_key" = 'deliberation_threshold_reached'
    )
    OR (
      "from_stage" = 'ballot_preparation'
      AND "to_stage" = 'voting'
      AND "reason_key" = 'ballot_prepared'
    )
    OR (
      "from_stage" = 'voting'
      AND "to_stage" = 'mandate'
      AND "reason_key" = 'voting_window_closed'
    )
    OR (
      "from_stage" = 'mandate'
      AND "to_stage" = 'action'
      AND "reason_key" = 'mandate_decided'
    )
  );
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "town"."reject_direct_civic_stage_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."current_stage" IS DISTINCT FROM OLD."current_stage"
     AND current_setting('town.civic_stage_transition', true)
       IS DISTINCT FROM 'confirmation_threshold'
     AND current_setting('town.civic_stage_transition', true)
       IS DISTINCT FROM 'proposal_threshold'
     AND current_setting('town.civic_stage_transition', true)
       IS DISTINCT FROM 'deliberation_threshold'
     AND current_setting('town.civic_stage_transition', true)
       IS DISTINCT FROM 'ballot_prepared'
     AND current_setting('town.civic_stage_transition', true)
       IS DISTINCT FROM 'voting_window_closed'
     AND current_setting('town.civic_stage_transition', true)
       IS DISTINCT FROM 'mandate_decided' THEN
    RAISE EXCEPTION 'civic process stage cannot be changed directly';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TABLE "town"."civic_action_updates" (
  "id" uuid PRIMARY KEY NOT NULL,
  "process_id" uuid NOT NULL,
  "author_actor_id" uuid NOT NULL,
  "text" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  CONSTRAINT "civic_action_updates_text_valid"
    CHECK (char_length(btrim("text")) BETWEEN 12 AND 480)
);
--> statement-breakpoint
ALTER TABLE "town"."civic_action_updates"
  ADD CONSTRAINT "civic_action_updates_process_id_fkey"
  FOREIGN KEY ("process_id") REFERENCES "town"."civic_processes"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "town"."civic_action_updates"
  ADD CONSTRAINT "civic_action_updates_author_actor_id_fkey"
  FOREIGN KEY ("author_actor_id") REFERENCES "town"."actors"("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "civic_action_updates_process_created_idx"
  ON "town"."civic_action_updates" USING btree ("process_id", "created_at", "id");
--> statement-breakpoint
CREATE FUNCTION "town"."guard_civic_action_update_insert"()
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

  IF process_stage IS DISTINCT FROM 'action' THEN
    RAISE EXCEPTION 'civic action stage is closed';
  END IF;

  SELECT "community_id", "status"
  INTO actor_community_id, actor_status
  FROM "town"."actors"
  WHERE "id" = NEW."author_actor_id";

  IF actor_status IS DISTINCT FROM 'active'
     OR actor_community_id IS DISTINCT FROM process_community_id THEN
    RAISE EXCEPTION 'civic action actor is not eligible for process community';
  END IF;

  NEW."text" := btrim(NEW."text");
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "civic_action_updates_guard_insert"
BEFORE INSERT ON "town"."civic_action_updates"
FOR EACH ROW EXECUTE FUNCTION "town"."guard_civic_action_update_insert"();

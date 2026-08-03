ALTER TABLE "town"."civic_processes"
  DROP CONSTRAINT "civic_processes_stage_supported";
--> statement-breakpoint
ALTER TABLE "town"."civic_processes"
  ADD CONSTRAINT "civic_processes_stage_supported"
  CHECK ("current_stage" IN ('confirmation', 'proposals', 'deliberation', 'ballot_preparation'));
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
      'stage_transitioned_to_ballot_preparation'
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
       IS DISTINCT FROM 'deliberation_threshold' THEN
    RAISE EXCEPTION 'civic process stage cannot be changed directly';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TABLE "town"."civic_deliberation_contributions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "process_id" uuid NOT NULL,
  "proposal_id" uuid NOT NULL,
  "author_actor_id" uuid NOT NULL,
  "intent" text NOT NULL,
  "text" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  CONSTRAINT "civic_deliberation_contributions_intent_supported"
    CHECK ("intent" IN ('observation', 'proposal', 'next_step')),
  CONSTRAINT "civic_deliberation_contributions_text_valid"
    CHECK (char_length(btrim("text")) BETWEEN 12 AND 480)
);
--> statement-breakpoint
ALTER TABLE "town"."civic_deliberation_contributions"
  ADD CONSTRAINT "civic_deliberation_contributions_process_id_fkey"
  FOREIGN KEY ("process_id") REFERENCES "town"."civic_processes"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "town"."civic_deliberation_contributions"
  ADD CONSTRAINT "civic_deliberation_contributions_proposal_id_fkey"
  FOREIGN KEY ("proposal_id") REFERENCES "town"."civic_proposals"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "town"."civic_deliberation_contributions"
  ADD CONSTRAINT "civic_deliberation_contributions_author_actor_id_fkey"
  FOREIGN KEY ("author_actor_id") REFERENCES "town"."actors"("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "civic_deliberation_contributions_process_created_idx"
  ON "town"."civic_deliberation_contributions" USING btree ("process_id", "created_at", "id");
--> statement-breakpoint
CREATE INDEX "civic_deliberation_contributions_proposal_created_idx"
  ON "town"."civic_deliberation_contributions" USING btree ("proposal_id", "created_at", "id");
--> statement-breakpoint
CREATE FUNCTION "town"."guard_civic_deliberation_insert"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  process_stage text;
  process_community_id uuid;
  proposal_process_id uuid;
  actor_community_id uuid;
  actor_status text;
BEGIN
  SELECT "current_stage", "community_id"
  INTO process_stage, process_community_id
  FROM "town"."civic_processes"
  WHERE "id" = NEW."process_id"
  FOR SHARE;

  IF process_stage IS DISTINCT FROM 'deliberation' THEN
    RAISE EXCEPTION 'civic deliberation stage is closed';
  END IF;

  SELECT "process_id"
  INTO proposal_process_id
  FROM "town"."civic_proposals"
  WHERE "id" = NEW."proposal_id";

  IF proposal_process_id IS DISTINCT FROM NEW."process_id" THEN
    RAISE EXCEPTION 'civic deliberation proposal does not belong to process';
  END IF;

  SELECT "community_id", "status"
  INTO actor_community_id, actor_status
  FROM "town"."actors"
  WHERE "id" = NEW."author_actor_id";

  IF actor_status IS DISTINCT FROM 'active'
     OR actor_community_id IS DISTINCT FROM process_community_id THEN
    RAISE EXCEPTION 'civic deliberation actor is not eligible for process community';
  END IF;

  NEW."text" := btrim(NEW."text");
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "civic_deliberation_contributions_guard_insert"
BEFORE INSERT ON "town"."civic_deliberation_contributions"
FOR EACH ROW EXECUTE FUNCTION "town"."guard_civic_deliberation_insert"();
--> statement-breakpoint
CREATE FUNCTION "town"."advance_civic_process_after_deliberation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_process_id uuid;
  process_stage text;
  participant_count integer;
  transition_at timestamp with time zone;
  transition_inserted integer;
BEGIN
  SELECT "id", "current_stage"
  INTO target_process_id, process_stage
  FROM "town"."civic_processes"
  WHERE "id" = NEW."process_id"
  FOR UPDATE;

  IF process_stage IS DISTINCT FROM 'deliberation' THEN
    RETURN NEW;
  END IF;

  SELECT count(DISTINCT "author_actor_id")::integer
  INTO participant_count
  FROM "town"."civic_deliberation_contributions"
  WHERE "process_id" = NEW."process_id";

  IF participant_count < 5 THEN
    RETURN NEW;
  END IF;

  SELECT first_contribution."first_at"
  INTO transition_at
  FROM (
    SELECT "author_actor_id", min("created_at") AS "first_at"
    FROM "town"."civic_deliberation_contributions"
    WHERE "process_id" = NEW."process_id"
    GROUP BY "author_actor_id"
  ) first_contribution
  ORDER BY first_contribution."first_at", first_contribution."author_actor_id"
  OFFSET 4
  LIMIT 1;

  INSERT INTO "town"."civic_process_transitions" (
    "id", "process_id", "from_stage", "to_stage", "reason_key", "occurred_at"
  ) VALUES (
    gen_random_uuid(),
    target_process_id,
    'deliberation',
    'ballot_preparation',
    'deliberation_threshold_reached',
    transition_at
  )
  ON CONFLICT ("process_id", "from_stage", "to_stage") DO NOTHING;

  GET DIAGNOSTICS transition_inserted = ROW_COUNT;
  IF transition_inserted = 0 THEN
    RETURN NEW;
  END IF;

  PERFORM set_config('town.civic_stage_transition', 'deliberation_threshold', true);
  UPDATE "town"."civic_processes"
  SET "current_stage" = 'ballot_preparation', "updated_at" = transition_at
  WHERE "id" = target_process_id AND "current_stage" = 'deliberation';
  PERFORM set_config('town.civic_stage_transition', '', true);

  INSERT INTO "town"."civic_process_events" (
    "id", "process_id", "event_type", "occurred_at"
  ) VALUES (
    gen_random_uuid(), target_process_id, 'stage_transitioned_to_ballot_preparation', transition_at
  )
  ON CONFLICT ("process_id", "event_type") DO NOTHING;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "civic_deliberation_contributions_advance_civic_process"
AFTER INSERT ON "town"."civic_deliberation_contributions"
FOR EACH ROW EXECUTE FUNCTION "town"."advance_civic_process_after_deliberation"();

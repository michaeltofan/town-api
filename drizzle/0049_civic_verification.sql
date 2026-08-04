ALTER TABLE "town"."civic_processes"
  DROP CONSTRAINT "civic_processes_stage_supported";
--> statement-breakpoint
ALTER TABLE "town"."civic_processes"
  ADD CONSTRAINT "civic_processes_stage_supported"
  CHECK (
    "current_stage" IN (
      'confirmation', 'proposals', 'deliberation', 'ballot_preparation', 'voting',
      'mandate', 'action', 'verification', 'archived'
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
      'stage_transitioned_to_action',
      'stage_transitioned_to_verification',
      'stage_transitioned_to_archived'
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
    OR (
      "from_stage" = 'action'
      AND "to_stage" = 'verification'
      AND "reason_key" = 'action_marked_ready'
    )
    OR (
      "from_stage" = 'verification'
      AND "to_stage" = 'archived'
      AND "reason_key" = 'verification_delivered_threshold_reached'
    )
    OR (
      "from_stage" = 'verification'
      AND "to_stage" = 'archived'
      AND "reason_key" = 'verification_not_delivered_threshold_reached'
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
       IS DISTINCT FROM 'mandate_decided'
     AND current_setting('town.civic_stage_transition', true)
       IS DISTINCT FROM 'action_marked_ready'
     AND current_setting('town.civic_stage_transition', true)
       IS DISTINCT FROM 'verification_delivered_threshold_reached'
     AND current_setting('town.civic_stage_transition', true)
       IS DISTINCT FROM 'verification_not_delivered_threshold_reached' THEN
    RAISE EXCEPTION 'civic process stage cannot be changed directly';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TABLE "town"."civic_verification_evidence" (
  "id" uuid PRIMARY KEY NOT NULL,
  "process_id" uuid NOT NULL,
  "author_actor_id" uuid NOT NULL,
  "text" text NOT NULL,
  "url" text,
  "created_at" timestamp with time zone NOT NULL,
  CONSTRAINT "civic_verification_evidence_text_valid"
    CHECK (char_length(btrim("text")) BETWEEN 12 AND 480),
  CONSTRAINT "civic_verification_evidence_url_valid"
    CHECK (
      "url" IS NULL
      OR (
        char_length(btrim("url")) BETWEEN 1 AND 500
        AND (btrim("url") LIKE 'http://%' OR btrim("url") LIKE 'https://%')
      )
    )
);
--> statement-breakpoint
ALTER TABLE "town"."civic_verification_evidence"
  ADD CONSTRAINT "civic_verification_evidence_process_id_fkey"
  FOREIGN KEY ("process_id") REFERENCES "town"."civic_processes"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "town"."civic_verification_evidence"
  ADD CONSTRAINT "civic_verification_evidence_author_actor_id_fkey"
  FOREIGN KEY ("author_actor_id") REFERENCES "town"."actors"("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "civic_verification_evidence_process_created_idx"
  ON "town"."civic_verification_evidence" USING btree ("process_id", "created_at", "id");
--> statement-breakpoint
CREATE FUNCTION "town"."guard_civic_verification_evidence_insert"()
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

  IF process_stage IS DISTINCT FROM 'verification' THEN
    RAISE EXCEPTION 'civic verification stage is closed';
  END IF;

  SELECT "community_id", "status"
  INTO actor_community_id, actor_status
  FROM "town"."actors"
  WHERE "id" = NEW."author_actor_id";

  IF actor_status IS DISTINCT FROM 'active'
     OR actor_community_id IS DISTINCT FROM process_community_id THEN
    RAISE EXCEPTION 'civic verification actor is not eligible for process community';
  END IF;

  NEW."text" := btrim(NEW."text");
  NEW."url" := btrim(NEW."url");
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "civic_verification_evidence_guard_insert"
BEFORE INSERT ON "town"."civic_verification_evidence"
FOR EACH ROW EXECUTE FUNCTION "town"."guard_civic_verification_evidence_insert"();
--> statement-breakpoint
CREATE TABLE "town"."civic_verification_confirmations" (
  "id" uuid PRIMARY KEY NOT NULL,
  "process_id" uuid NOT NULL,
  "actor_id" uuid NOT NULL,
  "outcome" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  CONSTRAINT "civic_verification_confirmations_outcome_supported"
    CHECK ("outcome" IN ('delivered', 'not_delivered'))
);
--> statement-breakpoint
ALTER TABLE "town"."civic_verification_confirmations"
  ADD CONSTRAINT "civic_verification_confirmations_process_id_fkey"
  FOREIGN KEY ("process_id") REFERENCES "town"."civic_processes"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "town"."civic_verification_confirmations"
  ADD CONSTRAINT "civic_verification_confirmations_actor_id_fkey"
  FOREIGN KEY ("actor_id") REFERENCES "town"."actors"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "town"."civic_verification_confirmations"
  ADD CONSTRAINT "civic_verification_confirmations_process_actor_unique"
  UNIQUE ("process_id", "actor_id");
--> statement-breakpoint
CREATE INDEX "civic_verification_confirmations_process_outcome_idx"
  ON "town"."civic_verification_confirmations" USING btree ("process_id", "outcome");
--> statement-breakpoint
CREATE FUNCTION "town"."guard_civic_verification_confirmation_insert"()
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

  IF process_stage IS DISTINCT FROM 'verification' THEN
    RAISE EXCEPTION 'civic verification stage is closed';
  END IF;

  SELECT "community_id", "status"
  INTO actor_community_id, actor_status
  FROM "town"."actors"
  WHERE "id" = NEW."actor_id";

  IF actor_status IS DISTINCT FROM 'active'
     OR actor_community_id IS DISTINCT FROM process_community_id THEN
    RAISE EXCEPTION 'civic verification actor is not eligible for process community';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "civic_verification_confirmations_guard_insert"
BEFORE INSERT ON "town"."civic_verification_confirmations"
FOR EACH ROW EXECUTE FUNCTION "town"."guard_civic_verification_confirmation_insert"();
--> statement-breakpoint
CREATE TABLE "town"."civic_verifications" (
  "process_id" uuid PRIMARY KEY NOT NULL,
  "outcome" text NOT NULL,
  "delivered_count" integer NOT NULL,
  "not_delivered_count" integer NOT NULL,
  "decided_at" timestamp with time zone NOT NULL,
  CONSTRAINT "civic_verifications_outcome_supported"
    CHECK ("outcome" IN ('delivered', 'not_delivered'))
);
--> statement-breakpoint
ALTER TABLE "town"."civic_verifications"
  ADD CONSTRAINT "civic_verifications_process_id_fkey"
  FOREIGN KEY ("process_id") REFERENCES "town"."civic_processes"("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE FUNCTION "town"."advance_civic_process_after_verification_confirmation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_process_id uuid;
  process_stage text;
  delivered_count integer;
  not_delivered_count integer;
  winning_outcome text;
  winning_reason text;
  transition_at timestamp with time zone;
  transition_inserted integer;
BEGIN
  SELECT "id", "current_stage"
  INTO target_process_id, process_stage
  FROM "town"."civic_processes"
  WHERE "id" = NEW."process_id"
  FOR UPDATE;

  IF process_stage IS DISTINCT FROM 'verification' THEN
    RETURN NEW;
  END IF;

  SELECT
    count(*) FILTER (WHERE "outcome" = 'delivered')::integer,
    count(*) FILTER (WHERE "outcome" = 'not_delivered')::integer
  INTO delivered_count, not_delivered_count
  FROM "town"."civic_verification_confirmations"
  WHERE "process_id" = NEW."process_id";

  IF delivered_count >= 5 THEN
    winning_outcome := 'delivered';
    winning_reason := 'verification_delivered_threshold_reached';
  ELSIF not_delivered_count >= 5 THEN
    winning_outcome := 'not_delivered';
    winning_reason := 'verification_not_delivered_threshold_reached';
  ELSE
    RETURN NEW;
  END IF;

  SELECT "created_at"
  INTO transition_at
  FROM "town"."civic_verification_confirmations"
  WHERE "process_id" = NEW."process_id" AND "outcome" = winning_outcome
  ORDER BY "created_at", "id"
  OFFSET 4
  LIMIT 1;

  INSERT INTO "town"."civic_process_transitions" (
    "id", "process_id", "from_stage", "to_stage", "reason_key", "occurred_at"
  ) VALUES (
    gen_random_uuid(), target_process_id, 'verification', 'archived', winning_reason, transition_at
  )
  ON CONFLICT ("process_id", "from_stage", "to_stage") DO NOTHING;

  GET DIAGNOSTICS transition_inserted = ROW_COUNT;
  IF transition_inserted = 0 THEN
    RETURN NEW;
  END IF;

  PERFORM set_config('town.civic_stage_transition', winning_reason, true);
  UPDATE "town"."civic_processes"
  SET "current_stage" = 'archived', "updated_at" = transition_at
  WHERE "id" = target_process_id AND "current_stage" = 'verification';
  PERFORM set_config('town.civic_stage_transition', '', true);

  INSERT INTO "town"."civic_process_events" (
    "id", "process_id", "event_type", "occurred_at"
  ) VALUES (
    gen_random_uuid(), target_process_id, 'stage_transitioned_to_archived', transition_at
  )
  ON CONFLICT ("process_id", "event_type") DO NOTHING;

  INSERT INTO "town"."civic_verifications" (
    "process_id", "outcome", "delivered_count", "not_delivered_count", "decided_at"
  ) VALUES (
    target_process_id, winning_outcome, delivered_count, not_delivered_count, transition_at
  )
  ON CONFLICT ("process_id") DO NOTHING;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "civic_verification_confirmations_advance_civic_process"
AFTER INSERT ON "town"."civic_verification_confirmations"
FOR EACH ROW EXECUTE FUNCTION "town"."advance_civic_process_after_verification_confirmation"();

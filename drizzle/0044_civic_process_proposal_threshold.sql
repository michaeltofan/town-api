ALTER TABLE "town"."civic_processes"
  DROP CONSTRAINT "civic_processes_stage_supported";
--> statement-breakpoint
ALTER TABLE "town"."civic_processes"
  ADD CONSTRAINT "civic_processes_stage_supported"
  CHECK ("current_stage" IN ('confirmation', 'proposals', 'deliberation'));
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
      'stage_transitioned_to_deliberation'
    )
  );
--> statement-breakpoint
ALTER TABLE "town"."civic_process_transitions"
  DROP CONSTRAINT "civic_process_transitions_confirmation_to_proposals";
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
       IS DISTINCT FROM 'proposal_threshold' THEN
    RAISE EXCEPTION 'civic process stage cannot be changed directly';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "town"."advance_civic_process_after_proposal"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_process_id uuid;
  process_stage text;
  proposal_count integer;
  transition_at timestamp with time zone;
  transition_inserted integer;
BEGIN
  SELECT "id", "current_stage"
  INTO target_process_id, process_stage
  FROM "town"."civic_processes"
  WHERE "id" = NEW."process_id"
  FOR UPDATE;

  IF process_stage IS DISTINCT FROM 'proposals' THEN
    RETURN NEW;
  END IF;

  SELECT count(*)::integer
  INTO proposal_count
  FROM "town"."civic_proposals"
  WHERE "process_id" = NEW."process_id";

  IF proposal_count < 5 THEN
    RETURN NEW;
  END IF;

  SELECT "created_at"
  INTO transition_at
  FROM "town"."civic_proposals"
  WHERE "process_id" = NEW."process_id"
  ORDER BY "created_at", "id"
  OFFSET 4
  LIMIT 1;

  INSERT INTO "town"."civic_process_transitions" (
    "id", "process_id", "from_stage", "to_stage", "reason_key", "occurred_at"
  ) VALUES (
    gen_random_uuid(),
    target_process_id,
    'proposals',
    'deliberation',
    'proposal_threshold_reached',
    transition_at
  )
  ON CONFLICT ("process_id", "from_stage", "to_stage") DO NOTHING;

  GET DIAGNOSTICS transition_inserted = ROW_COUNT;
  IF transition_inserted = 0 THEN
    RETURN NEW;
  END IF;

  PERFORM set_config('town.civic_stage_transition', 'proposal_threshold', true);
  UPDATE "town"."civic_processes"
  SET "current_stage" = 'deliberation', "updated_at" = transition_at
  WHERE "id" = target_process_id AND "current_stage" = 'proposals';
  PERFORM set_config('town.civic_stage_transition', '', true);

  INSERT INTO "town"."civic_process_events" (
    "id", "process_id", "event_type", "occurred_at"
  ) VALUES (
    gen_random_uuid(), target_process_id, 'stage_transitioned_to_deliberation', transition_at
  )
  ON CONFLICT ("process_id", "event_type") DO NOTHING;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
INSERT INTO "town"."civic_process_transitions" (
  "id", "process_id", "from_stage", "to_stage", "reason_key", "occurred_at"
)
SELECT
  gen_random_uuid(),
  process."id",
  'proposals',
  'deliberation',
  'proposal_threshold_reached',
  fifth."created_at"
FROM "town"."civic_processes" process
JOIN LATERAL (
  SELECT proposal."created_at"
  FROM "town"."civic_proposals" proposal
  WHERE proposal."process_id" = process."id"
  ORDER BY proposal."created_at", proposal."id"
  OFFSET 4
  LIMIT 1
) fifth ON true
WHERE process."current_stage" = 'proposals'
ON CONFLICT ("process_id", "from_stage", "to_stage") DO NOTHING;
--> statement-breakpoint
SELECT set_config('town.civic_stage_transition', 'proposal_threshold', true);
--> statement-breakpoint
UPDATE "town"."civic_processes" process
SET
  "current_stage" = 'deliberation',
  "updated_at" = transition."occurred_at"
FROM "town"."civic_process_transitions" transition
WHERE transition."process_id" = process."id"
  AND transition."from_stage" = 'proposals'
  AND transition."to_stage" = 'deliberation'
  AND process."current_stage" = 'proposals';
--> statement-breakpoint
SELECT set_config('town.civic_stage_transition', '', true);
--> statement-breakpoint
INSERT INTO "town"."civic_process_events" (
  "id", "process_id", "event_type", "occurred_at"
)
SELECT
  gen_random_uuid(),
  transition."process_id",
  'stage_transitioned_to_deliberation',
  transition."occurred_at"
FROM "town"."civic_process_transitions" transition
WHERE transition."from_stage" = 'proposals'
  AND transition."to_stage" = 'deliberation'
ON CONFLICT ("process_id", "event_type") DO NOTHING;
--> statement-breakpoint
CREATE TRIGGER "civic_proposals_advance_civic_process"
AFTER INSERT ON "town"."civic_proposals"
FOR EACH ROW EXECUTE FUNCTION "town"."advance_civic_process_after_proposal"();

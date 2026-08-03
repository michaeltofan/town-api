ALTER TABLE "town"."civic_processes"
  DROP CONSTRAINT "civic_processes_stage_confirmation";
--> statement-breakpoint
ALTER TABLE "town"."civic_processes"
  ADD CONSTRAINT "civic_processes_stage_supported"
  CHECK ("current_stage" IN ('confirmation', 'proposals'));
--> statement-breakpoint
ALTER TABLE "town"."civic_process_events"
  DROP CONSTRAINT "civic_process_events_type_process_created";
--> statement-breakpoint
ALTER TABLE "town"."civic_process_events"
  ADD CONSTRAINT "civic_process_events_type_supported"
  CHECK ("event_type" IN ('process_created', 'stage_transitioned_to_proposals'));
--> statement-breakpoint
ALTER TABLE "town"."civic_process_transitions"
  ADD CONSTRAINT "civic_process_transitions_process_path_unique"
  UNIQUE ("process_id", "from_stage", "to_stage");
--> statement-breakpoint
ALTER TABLE "town"."civic_process_transitions"
  ADD CONSTRAINT "civic_process_transitions_confirmation_to_proposals"
  CHECK (
    "from_stage" = 'confirmation'
    AND "to_stage" = 'proposals'
    AND "reason_key" = 'confirmation_threshold_reached'
  );
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "town"."reject_direct_civic_stage_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."current_stage" IS DISTINCT FROM OLD."current_stage"
     AND current_setting('town.civic_stage_transition', true)
       IS DISTINCT FROM 'confirmation_threshold' THEN
    RAISE EXCEPTION 'civic process stage cannot be changed directly';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "town"."guard_civic_confirmation_stage"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  process_stage text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW."signal_id"::text, 0));

  IF EXISTS (
    SELECT 1
    FROM "town"."signal_confirmations"
    WHERE "signal_id" = NEW."signal_id"
      AND "actor_id" = NEW."actor_id"
  ) THEN
    RETURN NEW;
  END IF;

  SELECT "current_stage"
  INTO process_stage
  FROM "town"."civic_processes"
  WHERE "signal_id" = NEW."signal_id";

  IF process_stage IS DISTINCT FROM 'confirmation' THEN
    RAISE EXCEPTION 'civic confirmation stage is closed';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "town"."advance_civic_process_after_confirmation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_process_id uuid;
  process_stage text;
  confirmation_count integer;
  transition_at timestamp with time zone;
  transition_inserted integer;
BEGIN
  SELECT "id", "current_stage"
  INTO target_process_id, process_stage
  FROM "town"."civic_processes"
  WHERE "signal_id" = NEW."signal_id"
  FOR UPDATE;

  IF process_stage IS DISTINCT FROM 'confirmation' THEN
    RETURN NEW;
  END IF;

  SELECT count(*)::integer
  INTO confirmation_count
  FROM "town"."signal_confirmations"
  WHERE "signal_id" = NEW."signal_id";

  IF confirmation_count < 5 THEN
    RETURN NEW;
  END IF;

  SELECT "confirmed_at"
  INTO transition_at
  FROM "town"."signal_confirmations"
  WHERE "signal_id" = NEW."signal_id"
  ORDER BY "confirmed_at", "id"
  OFFSET 4
  LIMIT 1;

  INSERT INTO "town"."civic_process_transitions" (
    "id", "process_id", "from_stage", "to_stage", "reason_key", "occurred_at"
  ) VALUES (
    gen_random_uuid(),
    target_process_id,
    'confirmation',
    'proposals',
    'confirmation_threshold_reached',
    transition_at
  )
  ON CONFLICT ("process_id", "from_stage", "to_stage") DO NOTHING;

  GET DIAGNOSTICS transition_inserted = ROW_COUNT;
  IF transition_inserted = 0 THEN
    RETURN NEW;
  END IF;

  PERFORM set_config('town.civic_stage_transition', 'confirmation_threshold', true);
  UPDATE "town"."civic_processes"
  SET "current_stage" = 'proposals', "updated_at" = transition_at
  WHERE "id" = target_process_id AND "current_stage" = 'confirmation';
  PERFORM set_config('town.civic_stage_transition', '', true);

  INSERT INTO "town"."civic_process_events" (
    "id", "process_id", "event_type", "occurred_at"
  ) VALUES (
    gen_random_uuid(), target_process_id, 'stage_transitioned_to_proposals', transition_at
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
  'confirmation',
  'proposals',
  'confirmation_threshold_reached',
  fifth."confirmed_at"
FROM "town"."civic_processes" process
JOIN LATERAL (
  SELECT confirmation."confirmed_at"
  FROM "town"."signal_confirmations" confirmation
  WHERE confirmation."signal_id" = process."signal_id"
  ORDER BY confirmation."confirmed_at", confirmation."id"
  OFFSET 4
  LIMIT 1
) fifth ON true
WHERE process."current_stage" = 'confirmation'
ON CONFLICT ("process_id", "from_stage", "to_stage") DO NOTHING;
--> statement-breakpoint
SELECT set_config('town.civic_stage_transition', 'confirmation_threshold', true);
--> statement-breakpoint
UPDATE "town"."civic_processes" process
SET
  "current_stage" = 'proposals',
  "updated_at" = transition."occurred_at"
FROM "town"."civic_process_transitions" transition
WHERE transition."process_id" = process."id"
  AND transition."from_stage" = 'confirmation'
  AND transition."to_stage" = 'proposals'
  AND process."current_stage" = 'confirmation';
--> statement-breakpoint
SELECT set_config('town.civic_stage_transition', '', true);
--> statement-breakpoint
INSERT INTO "town"."civic_process_events" (
  "id", "process_id", "event_type", "occurred_at"
)
SELECT
  gen_random_uuid(),
  transition."process_id",
  'stage_transitioned_to_proposals',
  transition."occurred_at"
FROM "town"."civic_process_transitions" transition
WHERE transition."from_stage" = 'confirmation'
  AND transition."to_stage" = 'proposals'
ON CONFLICT ("process_id", "event_type") DO NOTHING;
--> statement-breakpoint
CREATE TRIGGER "signal_confirmations_guard_civic_stage"
BEFORE INSERT ON "town"."signal_confirmations"
FOR EACH ROW EXECUTE FUNCTION "town"."guard_civic_confirmation_stage"();
--> statement-breakpoint
CREATE TRIGGER "signal_confirmations_advance_civic_process"
AFTER INSERT ON "town"."signal_confirmations"
FOR EACH ROW EXECUTE FUNCTION "town"."advance_civic_process_after_confirmation"();

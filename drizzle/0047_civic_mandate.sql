ALTER TABLE "town"."civic_processes"
  ADD COLUMN "voting_closes_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "town"."civic_processes"
  DROP CONSTRAINT "civic_processes_stage_supported";
--> statement-breakpoint
ALTER TABLE "town"."civic_processes"
  ADD CONSTRAINT "civic_processes_stage_supported"
  CHECK (
    "current_stage" IN (
      'confirmation', 'proposals', 'deliberation', 'ballot_preparation', 'voting', 'mandate'
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
      'stage_transitioned_to_mandate'
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
       IS DISTINCT FROM 'voting_window_closed' THEN
    RAISE EXCEPTION 'civic process stage cannot be changed directly';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "town"."advance_civic_process_after_deliberation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_process_id uuid;
  process_stage text;
  participant_count integer;
  transition_at timestamp with time zone;
  voting_transition_at timestamp with time zone;
  transition_inserted integer;
  ballot_transition_inserted integer;
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

  -- ballot_preparation carries no waiting period: the ballot is final the
  -- instant it is prepared, so voting opens in the same transaction. It is
  -- recorded a microsecond after ballot_preparation so the two events keep a
  -- well-defined, causally accurate order in the public timeline instead of
  -- tying on an identical timestamp.
  voting_transition_at := transition_at + interval '1 microsecond';

  INSERT INTO "town"."civic_process_transitions" (
    "id", "process_id", "from_stage", "to_stage", "reason_key", "occurred_at"
  ) VALUES (
    gen_random_uuid(),
    target_process_id,
    'ballot_preparation',
    'voting',
    'ballot_prepared',
    voting_transition_at
  )
  ON CONFLICT ("process_id", "from_stage", "to_stage") DO NOTHING;

  GET DIAGNOSTICS ballot_transition_inserted = ROW_COUNT;
  IF ballot_transition_inserted = 0 THEN
    RETURN NEW;
  END IF;

  PERFORM set_config('town.civic_stage_transition', 'ballot_prepared', true);
  UPDATE "town"."civic_processes"
  SET
    "current_stage" = 'voting',
    "updated_at" = voting_transition_at,
    "voting_closes_at" = voting_transition_at + interval '3 days'
  WHERE "id" = target_process_id AND "current_stage" = 'ballot_preparation';
  PERFORM set_config('town.civic_stage_transition', '', true);

  INSERT INTO "town"."civic_process_events" (
    "id", "process_id", "event_type", "occurred_at"
  ) VALUES (
    gen_random_uuid(), target_process_id, 'stage_transitioned_to_voting', voting_transition_at
  )
  ON CONFLICT ("process_id", "event_type") DO NOTHING;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TABLE "town"."civic_mandates" (
  "process_id" uuid PRIMARY KEY NOT NULL,
  "proposal_id" uuid,
  "vote_count" integer NOT NULL,
  "total_votes" integer NOT NULL,
  "decided_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "town"."civic_mandates"
  ADD CONSTRAINT "civic_mandates_process_id_fkey"
  FOREIGN KEY ("process_id") REFERENCES "town"."civic_processes"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "town"."civic_mandates"
  ADD CONSTRAINT "civic_mandates_proposal_id_fkey"
  FOREIGN KEY ("proposal_id") REFERENCES "town"."civic_proposals"("id") ON DELETE RESTRICT;

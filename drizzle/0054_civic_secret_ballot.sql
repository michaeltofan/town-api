ALTER TABLE "town"."civic_processes"
  ADD COLUMN "ballot_cycle" integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE "town"."civic_process_transitions"
  ADD COLUMN "ballot_cycle" integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE "town"."civic_process_transitions"
  DROP CONSTRAINT "civic_process_transitions_process_path_unique";
--> statement-breakpoint
ALTER TABLE "town"."civic_process_transitions"
  ADD CONSTRAINT "civic_process_transitions_process_path_unique"
  UNIQUE ("process_id", "from_stage", "to_stage", "ballot_cycle");
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
      AND "to_stage" = 'deliberation'
      AND "reason_key" = 'quorum_not_reached'
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
ALTER TABLE "town"."civic_process_events"
  ADD COLUMN "ballot_cycle" integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE "town"."civic_process_events"
  DROP CONSTRAINT "civic_process_events_process_type_unique";
--> statement-breakpoint
ALTER TABLE "town"."civic_process_events"
  ADD CONSTRAINT "civic_process_events_process_type_unique"
  UNIQUE ("process_id", "event_type", "ballot_cycle");
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
      'stage_returned_to_deliberation_after_quorum_failure',
      'stage_transitioned_to_mandate',
      'stage_transitioned_to_action',
      'stage_transitioned_to_verification',
      'stage_transitioned_to_archived'
    )
  );
--> statement-breakpoint
ALTER TABLE "town"."civic_ballot_eligible_actors"
  ADD COLUMN "ballot_cycle" integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE "town"."civic_ballot_eligible_actors"
  DROP CONSTRAINT "civic_ballot_eligible_actors_process_actor_unique";
--> statement-breakpoint
ALTER TABLE "town"."civic_ballot_eligible_actors"
  ADD CONSTRAINT "civic_ballot_eligible_actors_process_actor_unique"
  UNIQUE ("process_id", "actor_id", "ballot_cycle");
--> statement-breakpoint
CREATE TABLE "town"."civic_ballot_tokens" (
  "id" uuid PRIMARY KEY NOT NULL,
  "process_id" uuid NOT NULL,
  "actor_id" uuid NOT NULL,
  "ballot_cycle" integer NOT NULL,
  "issued_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  CONSTRAINT "civic_ballot_tokens_process_actor_cycle_unique"
    UNIQUE ("process_id", "actor_id", "ballot_cycle")
);
--> statement-breakpoint
ALTER TABLE "town"."civic_ballot_tokens"
  ADD CONSTRAINT "civic_ballot_tokens_process_id_fkey"
  FOREIGN KEY ("process_id") REFERENCES "town"."civic_processes"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "town"."civic_ballot_tokens"
  ADD CONSTRAINT "civic_ballot_tokens_actor_id_fkey"
  FOREIGN KEY ("actor_id") REFERENCES "town"."actors"("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "civic_ballot_tokens_process_idx"
  ON "town"."civic_ballot_tokens" USING btree ("process_id", "ballot_cycle");
--> statement-breakpoint
-- Secret ballot (§9): civic_votes is re-cut to hold no link back to the
-- actor or account that cast it. Eligibility and one-vote-per-actor are now
-- enforced entirely through civic_ballot_tokens consumption (a single
-- atomic UPDATE ... RETURNING ... INSERT statement issued by the route),
-- not by anything on the vote row itself.
ALTER TABLE "town"."civic_votes"
  DROP CONSTRAINT "civic_votes_process_actor_unique";
--> statement-breakpoint
ALTER TABLE "town"."civic_votes"
  DROP CONSTRAINT "civic_votes_actor_id_fkey";
--> statement-breakpoint
ALTER TABLE "town"."civic_votes"
  DROP COLUMN "actor_id";
--> statement-breakpoint
ALTER TABLE "town"."civic_votes"
  ADD COLUMN "ballot_cycle" integer NOT NULL DEFAULT 1;
--> statement-breakpoint
CREATE INDEX "civic_votes_process_cycle_idx"
  ON "town"."civic_votes" USING btree ("process_id", "ballot_cycle");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "town"."guard_civic_vote_insert"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  process_stage text;
  process_ballot_cycle integer;
  proposal_process_id uuid;
  proposal_lifecycle_state text;
BEGIN
  SELECT "current_stage", "ballot_cycle"
  INTO process_stage, process_ballot_cycle
  FROM "town"."civic_processes"
  WHERE "id" = NEW."process_id"
  FOR SHARE;

  IF process_stage IS DISTINCT FROM 'voting' THEN
    RAISE EXCEPTION 'civic voting stage is closed';
  END IF;

  IF NEW."ballot_cycle" IS DISTINCT FROM process_ballot_cycle THEN
    RAISE EXCEPTION 'civic vote ballot cycle does not match the process';
  END IF;

  SELECT "process_id", "lifecycle_state"
  INTO proposal_process_id, proposal_lifecycle_state
  FROM "town"."civic_proposals"
  WHERE "id" = NEW."proposal_id";

  IF proposal_process_id IS DISTINCT FROM NEW."process_id" THEN
    RAISE EXCEPTION 'civic vote proposal does not belong to process';
  END IF;

  IF proposal_lifecycle_state IS DISTINCT FROM 'frozen' THEN
    RAISE EXCEPTION 'civic vote proposal is not on the frozen ballot';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- Extend the stage-change bypass allowlist with the new quorum-failure
-- return path (voting -> deliberation).
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
       IS DISTINCT FROM 'quorum_not_reached'
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
-- The transitions/events unique constraints above gained a ballot_cycle
-- column, so every existing trigger function's ON CONFLICT target must be
-- re-declared to match it exactly (Postgres requires an exact column-list
-- match for ON CONFLICT inference) — even though these three edges never
-- repeat and always write the ballot_cycle default of 1.
CREATE OR REPLACE FUNCTION "town"."advance_civic_process_after_confirmation"()
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
  ON CONFLICT ("process_id", "from_stage", "to_stage", "ballot_cycle") DO NOTHING;

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
  ON CONFLICT ("process_id", "event_type", "ballot_cycle") DO NOTHING;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "town"."advance_civic_process_after_proposal"()
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
  ON CONFLICT ("process_id", "from_stage", "to_stage", "ballot_cycle") DO NOTHING;

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
  ON CONFLICT ("process_id", "event_type", "ballot_cycle") DO NOTHING;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "town"."advance_civic_process_after_verification_confirmation"()
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
  ON CONFLICT ("process_id", "from_stage", "to_stage", "ballot_cycle") DO NOTHING;

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
  ON CONFLICT ("process_id", "event_type", "ballot_cycle") DO NOTHING;

  INSERT INTO "town"."civic_verifications" (
    "process_id", "outcome", "delivered_count", "not_delivered_count", "decided_at"
  ) VALUES (
    target_process_id, winning_outcome, delivered_count, not_delivered_count, transition_at
  )
  ON CONFLICT (process_id) DO NOTHING;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- Freezing and eligible-voter snapshotting are now ballot-cycle aware: a
-- quorum-failure retry (§9) re-enters ballot_preparation for the SAME
-- process with an incremented ballot_cycle, re-snapshotting eligible
-- voters (membership may have changed) without re-freezing content that is
-- already frozen (frozen proposals are immutable and excluded from the
-- freeze UPDATE's WHERE clause, so re-running it on a later cycle is a
-- no-op for them).
CREATE OR REPLACE FUNCTION "town"."advance_civic_process_after_deliberation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_process_id uuid;
  process_stage text;
  process_community_id uuid;
  current_ballot_cycle integer;
  participant_count integer;
  transition_at timestamp with time zone;
  ballot_voting_opens_at timestamp with time zone;
  ballot_voting_closes_at timestamp with time zone;
  transition_inserted integer;
BEGIN
  SELECT "id", "current_stage", "community_id", "ballot_cycle"
  INTO target_process_id, process_stage, process_community_id, current_ballot_cycle
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

  IF current_ballot_cycle = 1 THEN
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
  ELSE
    -- A quorum-failure retry cycle only needs one more contribution to
    -- re-trigger — the cumulative distinct-participant count already
    -- cleared the threshold from the prior cycle. The triggering row's own
    -- timestamp is the honest moment this cycle's ballot preparation began.
    transition_at := NEW."created_at";
  END IF;

  INSERT INTO "town"."civic_process_transitions" (
    "id", "process_id", "from_stage", "to_stage", "reason_key", "occurred_at", "ballot_cycle"
  ) VALUES (
    gen_random_uuid(),
    target_process_id,
    'deliberation',
    'ballot_preparation',
    'deliberation_threshold_reached',
    transition_at,
    current_ballot_cycle
  )
  ON CONFLICT ("process_id", "from_stage", "to_stage", "ballot_cycle") DO NOTHING;

  GET DIAGNOSTICS transition_inserted = ROW_COUNT;
  IF transition_inserted = 0 THEN
    RETURN NEW;
  END IF;

  ballot_voting_opens_at := transition_at + interval '10 minutes';
  ballot_voting_closes_at := ballot_voting_opens_at + interval '3 days';

  PERFORM set_config('town.civic_stage_transition', 'deliberation_threshold', true);

  UPDATE "town"."civic_processes"
  SET
    "current_stage" = 'ballot_preparation',
    "updated_at" = transition_at,
    "voting_opens_at" = ballot_voting_opens_at,
    "voting_closes_at" = ballot_voting_closes_at
  WHERE "id" = target_process_id AND "current_stage" = 'deliberation';

  UPDATE "town"."civic_proposals"
  SET "lifecycle_state" = 'frozen', "frozen_at" = transition_at
  WHERE "process_id" = target_process_id
    AND "lifecycle_state" NOT IN ('withdrawn', 'frozen');

  PERFORM set_config('town.civic_stage_transition', '', true);

  INSERT INTO "town"."civic_process_events" (
    "id", "process_id", "event_type", "occurred_at", "ballot_cycle"
  ) VALUES (
    gen_random_uuid(), target_process_id, 'stage_transitioned_to_ballot_preparation',
    transition_at, current_ballot_cycle
  )
  ON CONFLICT ("process_id", "event_type", "ballot_cycle") DO NOTHING;

  INSERT INTO "town"."civic_ballot_eligible_actors" (
    "id", "process_id", "actor_id", "snapshotted_at", "ballot_cycle"
  )
  SELECT gen_random_uuid(), target_process_id, actor."id", transition_at, current_ballot_cycle
  FROM "town"."actors" actor
  WHERE actor."community_id" = process_community_id AND actor."status" = 'active'
  ON CONFLICT ("process_id", "actor_id", "ballot_cycle") DO NOTHING;

  RETURN NEW;
END;
$$;

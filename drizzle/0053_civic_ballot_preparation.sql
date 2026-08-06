ALTER TABLE "town"."civic_processes"
  ADD COLUMN "voting_opens_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "town"."civic_proposals"
  ADD COLUMN "frozen_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "town"."civic_proposals"
  DROP CONSTRAINT "civic_proposals_lifecycle_state_valid";
--> statement-breakpoint
ALTER TABLE "town"."civic_proposals"
  ADD CONSTRAINT "civic_proposals_lifecycle_state_valid"
  CHECK ("lifecycle_state" IN ('published', 'revised', 'withdrawn', 'frozen'));
--> statement-breakpoint
CREATE TABLE "town"."civic_ballot_eligible_actors" (
  "id" uuid PRIMARY KEY NOT NULL,
  "process_id" uuid NOT NULL,
  "actor_id" uuid NOT NULL,
  "snapshotted_at" timestamp with time zone NOT NULL,
  CONSTRAINT "civic_ballot_eligible_actors_process_actor_unique" UNIQUE ("process_id", "actor_id")
);
--> statement-breakpoint
ALTER TABLE "town"."civic_ballot_eligible_actors"
  ADD CONSTRAINT "civic_ballot_eligible_actors_process_id_fkey"
  FOREIGN KEY ("process_id") REFERENCES "town"."civic_processes"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "town"."civic_ballot_eligible_actors"
  ADD CONSTRAINT "civic_ballot_eligible_actors_actor_id_fkey"
  FOREIGN KEY ("actor_id") REFERENCES "town"."actors"("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "civic_ballot_eligible_actors_process_idx"
  ON "town"."civic_ballot_eligible_actors" USING btree ("process_id");
--> statement-breakpoint
CREATE FUNCTION "town"."reject_civic_ballot_eligible_actor_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'civic ballot eligible actor snapshot is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "civic_ballot_eligible_actors_append_only"
BEFORE UPDATE OR DELETE ON "town"."civic_ballot_eligible_actors"
FOR EACH ROW EXECUTE FUNCTION "town"."reject_civic_ballot_eligible_actor_mutation"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "town"."guard_civic_proposal_update"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  process_stage text;
BEGIN
  IF OLD."lifecycle_state" = 'withdrawn' THEN
    RAISE EXCEPTION 'withdrawn civic proposal cannot be modified';
  END IF;

  -- A frozen proposal is the fixed ballot content (§8): completely immutable
  -- from this point on, including withdrawal — the ballot an actor voted on
  -- can never be changed or pulled out from under a vote already cast.
  IF OLD."lifecycle_state" = 'frozen' THEN
    RAISE EXCEPTION 'frozen civic proposal cannot be modified';
  END IF;

  -- System freeze at ballot_preparation entry: only lifecycle_state/frozen_at
  -- may change, content is preserved exactly as last published/revised.
  -- Gated on the same session marker set by
  -- advance_civic_process_after_deliberation() so no other caller can freeze
  -- a proposal directly.
  IF NEW."lifecycle_state" = 'frozen' THEN
    IF current_setting('town.civic_stage_transition', true)
       IS DISTINCT FROM 'deliberation_threshold' THEN
      RAISE EXCEPTION 'civic proposal can only be frozen by the ballot preparation transition';
    END IF;
    IF NEW."title" IS DISTINCT FROM OLD."title"
       OR NEW."body" IS DISTINCT FROM OLD."body"
       OR NEW."target_institution" IS DISTINCT FROM OLD."target_institution"
       OR NEW."expected_outcome" IS DISTINCT FROM OLD."expected_outcome"
       OR NEW."estimated_resources" IS DISTINCT FROM OLD."estimated_resources"
       OR NEW."indicative_deadline" IS DISTINCT FROM OLD."indicative_deadline" THEN
      RAISE EXCEPTION 'freezing cannot change proposal content';
    END IF;
    IF NEW."frozen_at" IS NULL THEN
      RAISE EXCEPTION 'freezing requires frozen_at';
    END IF;
    RETURN NEW;
  END IF;

  -- Withdrawal: only lifecycle_state/withdrawn_at may change, content is frozen as-is.
  IF NEW."lifecycle_state" = 'withdrawn' THEN
    IF NEW."title" IS DISTINCT FROM OLD."title"
       OR NEW."body" IS DISTINCT FROM OLD."body"
       OR NEW."target_institution" IS DISTINCT FROM OLD."target_institution"
       OR NEW."expected_outcome" IS DISTINCT FROM OLD."expected_outcome"
       OR NEW."estimated_resources" IS DISTINCT FROM OLD."estimated_resources"
       OR NEW."indicative_deadline" IS DISTINCT FROM OLD."indicative_deadline" THEN
      RAISE EXCEPTION 'withdrawal cannot change proposal content';
    END IF;
    IF NEW."withdrawn_at" IS NULL THEN
      RAISE EXCEPTION 'withdrawal requires withdrawn_at';
    END IF;
    RETURN NEW;
  END IF;

  -- Content revision: allowed exactly once, only from 'published', only while the
  -- process is still in the proposals stage.
  IF NEW."title" IS DISTINCT FROM OLD."title"
     OR NEW."body" IS DISTINCT FROM OLD."body"
     OR NEW."target_institution" IS DISTINCT FROM OLD."target_institution"
     OR NEW."expected_outcome" IS DISTINCT FROM OLD."expected_outcome"
     OR NEW."estimated_resources" IS DISTINCT FROM OLD."estimated_resources"
     OR NEW."indicative_deadline" IS DISTINCT FROM OLD."indicative_deadline" THEN
    IF OLD."lifecycle_state" <> 'published' THEN
      RAISE EXCEPTION 'a civic proposal can only be revised once';
    END IF;

    SELECT "current_stage" INTO process_stage
    FROM "town"."civic_processes"
    WHERE "id" = OLD."process_id"
    FOR SHARE;

    IF process_stage IS DISTINCT FROM 'proposals' THEN
      RAISE EXCEPTION 'civic proposal stage is closed';
    END IF;

    INSERT INTO "town"."civic_proposal_revisions" (
      "id", "proposal_id", "previous_title", "previous_body",
      "previous_target_institution", "previous_expected_outcome",
      "previous_estimated_resources", "previous_indicative_deadline", "revised_at"
    ) VALUES (
      gen_random_uuid(), OLD."id", OLD."title", OLD."body",
      OLD."target_institution", OLD."expected_outcome",
      OLD."estimated_resources", OLD."indicative_deadline", now()
    );

    NEW."title" := btrim(NEW."title");
    NEW."body" := btrim(NEW."body");
    NEW."lifecycle_state" := 'revised';
    IF NEW."revised_at" IS NULL THEN
      NEW."revised_at" := now();
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- Voting eligibility is now governed by the frozen ballot snapshot (§8)
-- instead of live actor status/community — the whole point of snapshotting
-- eligible voters at freeze time is that later membership changes never
-- add or remove who may vote on a ballot already frozen.
CREATE OR REPLACE FUNCTION "town"."guard_civic_vote_insert"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  process_stage text;
  proposal_process_id uuid;
  is_eligible boolean;
BEGIN
  SELECT "current_stage"
  INTO process_stage
  FROM "town"."civic_processes"
  WHERE "id" = NEW."process_id"
  FOR SHARE;

  IF process_stage IS DISTINCT FROM 'voting' THEN
    RAISE EXCEPTION 'civic voting stage is closed';
  END IF;

  SELECT "process_id"
  INTO proposal_process_id
  FROM "town"."civic_proposals"
  WHERE "id" = NEW."proposal_id";

  IF proposal_process_id IS DISTINCT FROM NEW."process_id" THEN
    RAISE EXCEPTION 'civic vote proposal does not belong to process';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM "town"."civic_ballot_eligible_actors"
    WHERE "process_id" = NEW."process_id" AND "actor_id" = NEW."actor_id"
  ) INTO is_eligible;

  IF NOT is_eligible THEN
    RAISE EXCEPTION 'civic vote actor is not eligible for process community';
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
  process_community_id uuid;
  participant_count integer;
  transition_at timestamp with time zone;
  ballot_voting_opens_at timestamp with time zone;
  ballot_voting_closes_at timestamp with time zone;
  transition_inserted integer;
BEGIN
  SELECT "id", "current_stage", "community_id"
  INTO target_process_id, process_stage, process_community_id
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

  -- Ballot preparation is a real 10-minute freeze window (§8): the ballot's
  -- 72-hour voting window is measured from when voting actually opens (the
  -- end of the freeze window), not from the freeze instant itself, so
  -- eligible actors always get the full 72 hours to vote.
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

  -- Freeze every non-withdrawn proposal: content is locked as of this
  -- moment and the frozen set becomes the fixed ballot. Withdrawn proposals
  -- are excluded and never re-enter the ballot.
  UPDATE "town"."civic_proposals"
  SET "lifecycle_state" = 'frozen', "frozen_at" = transition_at
  WHERE "process_id" = target_process_id AND "lifecycle_state" <> 'withdrawn';

  PERFORM set_config('town.civic_stage_transition', '', true);

  INSERT INTO "town"."civic_process_events" (
    "id", "process_id", "event_type", "occurred_at"
  ) VALUES (
    gen_random_uuid(), target_process_id, 'stage_transitioned_to_ballot_preparation', transition_at
  )
  ON CONFLICT ("process_id", "event_type") DO NOTHING;

  -- Snapshot the eligible-voter list at freeze time: later membership
  -- changes never add or remove eligible voters for a ballot already frozen.
  INSERT INTO "town"."civic_ballot_eligible_actors" (
    "id", "process_id", "actor_id", "snapshotted_at"
  )
  SELECT gen_random_uuid(), target_process_id, actor."id", transition_at
  FROM "town"."actors" actor
  WHERE actor."community_id" = process_community_id AND actor."status" = 'active'
  ON CONFLICT ("process_id", "actor_id") DO NOTHING;

  -- Unlike earlier iterations, ballot_preparation no longer opens voting in
  -- the same transaction: the 10-minute freeze window is enforced lazily
  -- (openVotingIfBallotPreparationElapsed), the same pattern already used to
  -- lazily close the voting window.
  RETURN NEW;
END;
$$;

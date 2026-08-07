-- §14 fix: guard_civic_proposal_update() (0051/0053) blocks ANY update to a
-- frozen or withdrawn proposal, including the moderation-only hidden_*
-- columns added in 0057. But a winning proposal is always frozen by the
-- time it reaches action/verification — exactly when it is most likely to
-- need moderation. Ballot-content immutability (§8) is about title/body/etc,
-- not visibility, so a change touching none of the substantive/lifecycle
-- columns is allowed to bypass the frozen/withdrawn guards entirely.
CREATE OR REPLACE FUNCTION "town"."guard_civic_proposal_update"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  process_stage text;
BEGIN
  IF NEW."title" IS NOT DISTINCT FROM OLD."title"
     AND NEW."body" IS NOT DISTINCT FROM OLD."body"
     AND NEW."target_institution" IS NOT DISTINCT FROM OLD."target_institution"
     AND NEW."expected_outcome" IS NOT DISTINCT FROM OLD."expected_outcome"
     AND NEW."estimated_resources" IS NOT DISTINCT FROM OLD."estimated_resources"
     AND NEW."indicative_deadline" IS NOT DISTINCT FROM OLD."indicative_deadline"
     AND NEW."lifecycle_state" IS NOT DISTINCT FROM OLD."lifecycle_state"
     AND NEW."revised_at" IS NOT DISTINCT FROM OLD."revised_at"
     AND NEW."withdrawn_at" IS NOT DISTINCT FROM OLD."withdrawn_at"
     AND NEW."frozen_at" IS NOT DISTINCT FROM OLD."frozen_at"
  THEN
    RETURN NEW;
  END IF;

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

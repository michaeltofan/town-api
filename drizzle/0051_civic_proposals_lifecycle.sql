ALTER TABLE "town"."civic_proposals"
  ADD COLUMN "target_institution" text,
  ADD COLUMN "expected_outcome" text,
  ADD COLUMN "estimated_resources" text,
  ADD COLUMN "indicative_deadline" date,
  ADD COLUMN "lifecycle_state" text NOT NULL DEFAULT 'published',
  ADD COLUMN "revised_at" timestamp with time zone,
  ADD COLUMN "withdrawn_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "town"."civic_proposals"
  ADD CONSTRAINT "civic_proposals_target_institution_valid"
  CHECK ("target_institution" IS NULL OR char_length(btrim("target_institution")) BETWEEN 1 AND 200);
--> statement-breakpoint
ALTER TABLE "town"."civic_proposals"
  ADD CONSTRAINT "civic_proposals_expected_outcome_valid"
  CHECK ("expected_outcome" IS NULL OR char_length(btrim("expected_outcome")) BETWEEN 1 AND 500);
--> statement-breakpoint
ALTER TABLE "town"."civic_proposals"
  ADD CONSTRAINT "civic_proposals_estimated_resources_valid"
  CHECK ("estimated_resources" IS NULL OR char_length(btrim("estimated_resources")) BETWEEN 1 AND 500);
--> statement-breakpoint
ALTER TABLE "town"."civic_proposals"
  ADD CONSTRAINT "civic_proposals_lifecycle_state_valid"
  CHECK ("lifecycle_state" IN ('published', 'revised', 'withdrawn'));
--> statement-breakpoint
CREATE TABLE "town"."civic_proposal_revisions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "proposal_id" uuid NOT NULL,
  "previous_title" text NOT NULL,
  "previous_body" text NOT NULL,
  "previous_target_institution" text,
  "previous_expected_outcome" text,
  "previous_estimated_resources" text,
  "previous_indicative_deadline" date,
  "revised_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "town"."civic_proposal_revisions"
  ADD CONSTRAINT "civic_proposal_revisions_proposal_id_fkey"
  FOREIGN KEY ("proposal_id") REFERENCES "town"."civic_proposals"("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "civic_proposal_revisions_proposal_idx"
  ON "town"."civic_proposal_revisions" USING btree ("proposal_id", "revised_at");
--> statement-breakpoint
CREATE FUNCTION "town"."reject_civic_proposal_revision_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'civic proposal revision ledger is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "civic_proposal_revisions_append_only"
BEFORE UPDATE OR DELETE ON "town"."civic_proposal_revisions"
FOR EACH ROW EXECUTE FUNCTION "town"."reject_civic_proposal_revision_mutation"();
--> statement-breakpoint
CREATE FUNCTION "town"."guard_civic_proposal_update"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  process_stage text;
BEGIN
  IF OLD."lifecycle_state" = 'withdrawn' THEN
    RAISE EXCEPTION 'withdrawn civic proposal cannot be modified';
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
CREATE TRIGGER "civic_proposals_guard_update"
BEFORE UPDATE ON "town"."civic_proposals"
FOR EACH ROW EXECUTE FUNCTION "town"."guard_civic_proposal_update"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "town"."guard_civic_proposal_insert"()
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
  IF NEW."target_institution" IS NOT NULL THEN
    NEW."target_institution" := btrim(NEW."target_institution");
  END IF;
  IF NEW."expected_outcome" IS NOT NULL THEN
    NEW."expected_outcome" := btrim(NEW."expected_outcome");
  END IF;
  IF NEW."estimated_resources" IS NOT NULL THEN
    NEW."estimated_resources" := btrim(NEW."estimated_resources");
  END IF;
  NEW."lifecycle_state" := 'published';
  RETURN NEW;
END;
$$;

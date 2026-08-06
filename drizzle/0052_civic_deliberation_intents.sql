ALTER TABLE "town"."civic_deliberation_contributions"
  DROP CONSTRAINT "civic_deliberation_contributions_intent_supported";
--> statement-breakpoint
ALTER TABLE "town"."civic_deliberation_contributions"
  ADD CONSTRAINT "civic_deliberation_contributions_intent_supported"
  CHECK (
    "intent" IN (
      'observation',
      'proposal',
      'next_step',
      'argument_for',
      'risk_or_objection',
      'question',
      'author_response',
      'evidence',
      'amendment_suggestion',
      'minority_position'
    )
  );
--> statement-breakpoint
ALTER TABLE "town"."civic_deliberation_contributions"
  ADD COLUMN "reply_to_contribution_id" uuid;
--> statement-breakpoint
ALTER TABLE "town"."civic_deliberation_contributions"
  ADD CONSTRAINT "civic_deliberation_contributions_reply_to_fkey"
  FOREIGN KEY ("reply_to_contribution_id")
  REFERENCES "town"."civic_deliberation_contributions"("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "civic_deliberation_contributions_reply_to_idx"
  ON "town"."civic_deliberation_contributions" USING btree ("reply_to_contribution_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "town"."guard_civic_deliberation_insert"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  process_stage text;
  process_community_id uuid;
  proposal_process_id uuid;
  actor_community_id uuid;
  actor_status text;
  reply_to_proposal_id uuid;
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

  IF NEW."reply_to_contribution_id" IS NOT NULL THEN
    SELECT "proposal_id"
    INTO reply_to_proposal_id
    FROM "town"."civic_deliberation_contributions"
    WHERE "id" = NEW."reply_to_contribution_id";

    IF reply_to_proposal_id IS DISTINCT FROM NEW."proposal_id" THEN
      RAISE EXCEPTION 'civic deliberation reply must target the same proposal';
    END IF;
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

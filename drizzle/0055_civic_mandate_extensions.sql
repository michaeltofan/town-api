-- Mandate extensions (§10, §11): minority position surfacing needs no
-- schema change (it reads existing civic_deliberation_contributions rows
-- with intent = 'minority_position', already supported since 0052). This
-- migration adds procedural contestation of a decided mandate.
CREATE TABLE "town"."civic_mandate_contestations" (
  "id" uuid PRIMARY KEY NOT NULL,
  "process_id" uuid NOT NULL,
  "filer_actor_id" uuid NOT NULL,
  "reason_key" text NOT NULL,
  "elaboration" text,
  "status" text NOT NULL DEFAULT 'pending',
  "filed_at" timestamp with time zone NOT NULL,
  CONSTRAINT "civic_mandate_contestations_process_filer_unique"
    UNIQUE ("process_id", "filer_actor_id")
);
--> statement-breakpoint
ALTER TABLE "town"."civic_mandate_contestations"
  ADD CONSTRAINT "civic_mandate_contestations_process_id_fkey"
  FOREIGN KEY ("process_id") REFERENCES "town"."civic_processes"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "town"."civic_mandate_contestations"
  ADD CONSTRAINT "civic_mandate_contestations_filer_actor_id_fkey"
  FOREIGN KEY ("filer_actor_id") REFERENCES "town"."actors"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "town"."civic_mandate_contestations"
  ADD CONSTRAINT "civic_mandate_contestations_reason_key_supported"
  CHECK ("reason_key" IN ('eligibility_error', 'ballot_tampering_suspected', 'count_discrepancy'));
--> statement-breakpoint
ALTER TABLE "town"."civic_mandate_contestations"
  ADD CONSTRAINT "civic_mandate_contestations_status_supported"
  CHECK ("status" IN ('pending', 'upheld', 'rejected'));
--> statement-breakpoint
ALTER TABLE "town"."civic_mandate_contestations"
  ADD CONSTRAINT "civic_mandate_contestations_elaboration_valid"
  CHECK ("elaboration" IS NULL OR char_length(btrim("elaboration")) BETWEEN 1 AND 1000);
--> statement-breakpoint
CREATE INDEX "civic_mandate_contestations_process_idx"
  ON "town"."civic_mandate_contestations" USING btree ("process_id");
--> statement-breakpoint
-- A contestation is filed openly under the actor's own identity (unlike a
-- vote): accountability for procedural disputes is the point, so this guard
-- checks eligibility the same way ballot casting does, but there is no
-- secrecy requirement here.
CREATE OR REPLACE FUNCTION "town"."guard_civic_mandate_contestation_insert"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  mandate_exists boolean;
  process_voting_closes_at timestamptz;
  process_ballot_cycle integer;
  filer_eligible boolean;
BEGIN
  SELECT EXISTS(
    SELECT 1 FROM "town"."civic_mandates" WHERE "process_id" = NEW."process_id"
  ) INTO mandate_exists;

  IF NOT mandate_exists THEN
    RAISE EXCEPTION 'civic mandate contestation requires a decided mandate';
  END IF;

  SELECT "voting_closes_at", "ballot_cycle"
  INTO process_voting_closes_at, process_ballot_cycle
  FROM "town"."civic_processes"
  WHERE "id" = NEW."process_id"
  FOR SHARE;

  IF process_voting_closes_at IS NULL
     OR NEW."filed_at" > process_voting_closes_at + interval '72 hours' THEN
    RAISE EXCEPTION 'civic mandate contestation window has closed';
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM "town"."civic_ballot_eligible_actors"
    WHERE "process_id" = NEW."process_id"
      AND "actor_id" = NEW."filer_actor_id"
      AND "ballot_cycle" = process_ballot_cycle
  ) INTO filer_eligible;

  IF NOT filer_eligible THEN
    RAISE EXCEPTION 'civic mandate contestation filer was not eligible for the decisive ballot';
  END IF;

  NEW."elaboration" := NULLIF(btrim(COALESCE(NEW."elaboration", '')), '');
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "civic_mandate_contestations_guard_insert"
BEFORE INSERT ON "town"."civic_mandate_contestations"
FOR EACH ROW EXECUTE FUNCTION "town"."guard_civic_mandate_contestation_insert"();

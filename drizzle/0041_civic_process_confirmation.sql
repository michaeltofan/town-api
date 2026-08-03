ALTER TABLE "town"."signals"
  ADD CONSTRAINT "signals_id_community_id_unique" UNIQUE("id", "community_id");
--> statement-breakpoint
CREATE TABLE "town"."civic_processes" (
  "id" uuid PRIMARY KEY NOT NULL,
  "signal_id" uuid NOT NULL,
  "community_id" uuid NOT NULL,
  "current_stage" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "civic_processes_signal_id_unique" UNIQUE("signal_id"),
  CONSTRAINT "civic_processes_stage_confirmation" CHECK ("current_stage" = 'confirmation')
);
--> statement-breakpoint
CREATE TABLE "town"."civic_process_transitions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "process_id" uuid NOT NULL,
  "from_stage" text NOT NULL,
  "to_stage" text NOT NULL,
  "reason_key" text NOT NULL,
  "occurred_at" timestamp with time zone NOT NULL,
  CONSTRAINT "civic_process_transitions_stage_changed" CHECK ("from_stage" <> "to_stage")
);
--> statement-breakpoint
CREATE TABLE "town"."civic_process_events" (
  "id" uuid PRIMARY KEY NOT NULL,
  "process_id" uuid NOT NULL,
  "event_type" text NOT NULL,
  "occurred_at" timestamp with time zone NOT NULL,
  CONSTRAINT "civic_process_events_process_type_unique" UNIQUE("process_id", "event_type"),
  CONSTRAINT "civic_process_events_type_process_created" CHECK ("event_type" = 'process_created')
);
--> statement-breakpoint
ALTER TABLE "town"."civic_processes"
  ADD CONSTRAINT "civic_processes_signal_community_fkey"
  FOREIGN KEY ("signal_id", "community_id")
  REFERENCES "town"."signals"("id", "community_id")
  ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "town"."civic_process_transitions"
  ADD CONSTRAINT "civic_process_transitions_process_id_fkey"
  FOREIGN KEY ("process_id") REFERENCES "town"."civic_processes"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "town"."civic_process_events"
  ADD CONSTRAINT "civic_process_events_process_id_fkey"
  FOREIGN KEY ("process_id") REFERENCES "town"."civic_processes"("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "civic_processes_community_created_idx"
  ON "town"."civic_processes" USING btree ("community_id", "created_at");
--> statement-breakpoint
CREATE INDEX "civic_process_transitions_process_occurred_idx"
  ON "town"."civic_process_transitions" USING btree ("process_id", "occurred_at");
--> statement-breakpoint
CREATE INDEX "civic_process_events_process_occurred_idx"
  ON "town"."civic_process_events" USING btree ("process_id", "occurred_at");
--> statement-breakpoint
INSERT INTO "town"."civic_processes" (
  "id", "signal_id", "community_id", "current_stage", "created_at", "updated_at"
)
SELECT gen_random_uuid(), "id", "community_id", 'confirmation', "created_at", "created_at"
FROM "town"."signals"
ON CONFLICT ("signal_id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "town"."civic_process_events" ("id", "process_id", "event_type", "occurred_at")
SELECT gen_random_uuid(), "id", 'process_created', "created_at"
FROM "town"."civic_processes"
ON CONFLICT ("process_id", "event_type") DO NOTHING;
--> statement-breakpoint
CREATE FUNCTION "town"."provision_civic_process_for_signal"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  process_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO "town"."civic_processes" (
    "id", "signal_id", "community_id", "current_stage", "created_at", "updated_at"
  ) VALUES (
    process_id, NEW."id", NEW."community_id", 'confirmation', NEW."created_at", NEW."created_at"
  );

  INSERT INTO "town"."civic_process_events" ("id", "process_id", "event_type", "occurred_at")
  VALUES (gen_random_uuid(), process_id, 'process_created', NEW."created_at");
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "signals_provision_civic_process"
AFTER INSERT ON "town"."signals"
FOR EACH ROW EXECUTE FUNCTION "town"."provision_civic_process_for_signal"();
--> statement-breakpoint
CREATE FUNCTION "town"."reject_civic_process_append_only_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'civic process ledger is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "civic_process_events_append_only"
BEFORE UPDATE OR DELETE ON "town"."civic_process_events"
FOR EACH ROW EXECUTE FUNCTION "town"."reject_civic_process_append_only_mutation"();
--> statement-breakpoint
CREATE TRIGGER "civic_process_transitions_append_only"
BEFORE UPDATE OR DELETE ON "town"."civic_process_transitions"
FOR EACH ROW EXECUTE FUNCTION "town"."reject_civic_process_append_only_mutation"();
--> statement-breakpoint
CREATE FUNCTION "town"."reject_direct_civic_stage_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."current_stage" IS DISTINCT FROM OLD."current_stage" THEN
    RAISE EXCEPTION 'civic process stage cannot be changed directly';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "civic_processes_no_direct_stage_change"
BEFORE UPDATE ON "town"."civic_processes"
FOR EACH ROW EXECUTE FUNCTION "town"."reject_direct_civic_stage_change"();

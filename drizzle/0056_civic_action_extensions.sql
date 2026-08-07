-- Civic action extensions (§12): the owner's contextual actions become
-- typed update subtypes on the existing civic_action_updates table — no new
-- tables. "Named responsible actor" and "collaborators" are never a
-- separately stored assignment: they are derived by reading which actor(s)
-- posted a take_step / offer_help update, exactly like every other derived
-- state in this schema (quorum failure, minority position, etc). Target
-- institution, objective, and indicative deadline already exist on the
-- winning civic_proposals row (added in 0051) and only need surfacing on
-- the action route, not new storage.
ALTER TABLE "town"."civic_action_updates"
  ADD COLUMN "kind" text NOT NULL DEFAULT 'status_update';
--> statement-breakpoint
ALTER TABLE "town"."civic_action_updates"
  ADD CONSTRAINT "civic_action_updates_kind_supported"
  CHECK (
    "kind" IN ('status_update', 'take_step', 'offer_help', 'evidence', 'institution_response')
  );
--> statement-breakpoint
ALTER TABLE "town"."civic_action_updates"
  ADD COLUMN "blocked_reason_key" text;
--> statement-breakpoint
ALTER TABLE "town"."civic_action_updates"
  ADD CONSTRAINT "civic_action_updates_blocked_reason_valid"
  CHECK (
    "blocked_reason_key" IS NULL
    OR (
      "kind" = 'status_update'
      AND "blocked_reason_key" IN (
        'awaiting_institution_response', 'awaiting_resources', 'awaiting_volunteers', 'other'
      )
    )
  );
--> statement-breakpoint
ALTER TABLE "town"."civic_action_updates"
  ADD COLUMN "url" text;
--> statement-breakpoint
ALTER TABLE "town"."civic_action_updates"
  ADD CONSTRAINT "civic_action_updates_url_valid"
  CHECK (
    "url" IS NULL
    OR (
      "kind" = 'evidence'
      AND char_length(btrim("url")) BETWEEN 1 AND 500
      AND (btrim("url") LIKE 'http://%' OR btrim("url") LIKE 'https://%')
    )
  );
--> statement-breakpoint
-- At most one actor is ever "the" named responsible actor per process —
-- first claim wins, immutable, exactly like every other permanent record
-- in this schema. A second attempt fails closed with a clean 409, rather
-- than silently being ignored.
CREATE UNIQUE INDEX "civic_action_updates_one_responsible_actor_idx"
  ON "town"."civic_action_updates" USING btree ("process_id") WHERE "kind" = 'take_step';

-- Civic moderation (§14): new moderate_civic_process capability covering
-- exactly three things — hide/restore a proposal, deliberation
-- contribution, or verification evidence item (mirrors the existing
-- signals/discussion-contribution hide pattern exactly: hidden, not
-- deleted); recording a procedural contestation outcome (§10); and
-- recording a stalled verification-dispute outcome (§13). None of these
-- touch current_stage, civic_process_transitions, or civic_process_events
-- — a resolved dispute stays technically "verification" forever, the
-- resolution is a public, permanent annotation layered on top, never a
-- rewritten state machine.

ALTER TABLE "town"."civic_proposals"
  ADD COLUMN "hidden_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "town"."civic_proposals"
  ADD COLUMN "hidden_reason" text;
--> statement-breakpoint
ALTER TABLE "town"."civic_proposals"
  ADD COLUMN "hidden_by_account_id" uuid;
--> statement-breakpoint
ALTER TABLE "town"."civic_proposals"
  ADD CONSTRAINT "civic_proposals_hidden_by_account_id_fkey"
  FOREIGN KEY ("hidden_by_account_id") REFERENCES "town"."accounts"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "town"."civic_proposals"
  ADD CONSTRAINT "civic_proposals_hidden_reason_valid"
  CHECK ("hidden_reason" IS NULL OR "hidden_reason" IN ('immoral', 'abusive', 'spam', 'off_topic', 'illegal', 'other'));
--> statement-breakpoint
ALTER TABLE "town"."civic_proposals"
  ADD CONSTRAINT "civic_proposals_hidden_state_consistent"
  CHECK (
    ("hidden_at" IS NULL AND "hidden_reason" IS NULL AND "hidden_by_account_id" IS NULL)
    OR ("hidden_at" IS NOT NULL AND "hidden_reason" IS NOT NULL AND "hidden_by_account_id" IS NOT NULL)
  );
--> statement-breakpoint

ALTER TABLE "town"."civic_deliberation_contributions"
  ADD COLUMN "hidden_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "town"."civic_deliberation_contributions"
  ADD COLUMN "hidden_reason" text;
--> statement-breakpoint
ALTER TABLE "town"."civic_deliberation_contributions"
  ADD COLUMN "hidden_by_account_id" uuid;
--> statement-breakpoint
ALTER TABLE "town"."civic_deliberation_contributions"
  ADD CONSTRAINT "civic_deliberation_contributions_hidden_by_account_id_fkey"
  FOREIGN KEY ("hidden_by_account_id") REFERENCES "town"."accounts"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "town"."civic_deliberation_contributions"
  ADD CONSTRAINT "civic_deliberation_contributions_hidden_reason_valid"
  CHECK ("hidden_reason" IS NULL OR "hidden_reason" IN ('immoral', 'abusive', 'spam', 'off_topic', 'illegal', 'other'));
--> statement-breakpoint
ALTER TABLE "town"."civic_deliberation_contributions"
  ADD CONSTRAINT "civic_deliberation_contributions_hidden_state_consistent"
  CHECK (
    ("hidden_at" IS NULL AND "hidden_reason" IS NULL AND "hidden_by_account_id" IS NULL)
    OR ("hidden_at" IS NOT NULL AND "hidden_reason" IS NOT NULL AND "hidden_by_account_id" IS NOT NULL)
  );
--> statement-breakpoint

ALTER TABLE "town"."civic_verification_evidence"
  ADD COLUMN "hidden_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "town"."civic_verification_evidence"
  ADD COLUMN "hidden_reason" text;
--> statement-breakpoint
ALTER TABLE "town"."civic_verification_evidence"
  ADD COLUMN "hidden_by_account_id" uuid;
--> statement-breakpoint
ALTER TABLE "town"."civic_verification_evidence"
  ADD CONSTRAINT "civic_verification_evidence_hidden_by_account_id_fkey"
  FOREIGN KEY ("hidden_by_account_id") REFERENCES "town"."accounts"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "town"."civic_verification_evidence"
  ADD CONSTRAINT "civic_verification_evidence_hidden_reason_valid"
  CHECK ("hidden_reason" IS NULL OR "hidden_reason" IN ('immoral', 'abusive', 'spam', 'off_topic', 'illegal', 'other'));
--> statement-breakpoint
ALTER TABLE "town"."civic_verification_evidence"
  ADD CONSTRAINT "civic_verification_evidence_hidden_state_consistent"
  CHECK (
    ("hidden_at" IS NULL AND "hidden_reason" IS NULL AND "hidden_by_account_id" IS NULL)
    OR ("hidden_at" IS NOT NULL AND "hidden_reason" IS NOT NULL AND "hidden_by_account_id" IS NOT NULL)
  );
--> statement-breakpoint

-- §10: recording a procedural contestation outcome. reviewed_* columns
-- stay NULL while status = 'pending'; set together, once, when an
-- operator moves status to 'upheld' or 'rejected'.
ALTER TABLE "town"."civic_mandate_contestations"
  ADD COLUMN "reviewed_by_account_id" uuid;
--> statement-breakpoint
ALTER TABLE "town"."civic_mandate_contestations"
  ADD COLUMN "reviewed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "town"."civic_mandate_contestations"
  ADD COLUMN "review_note" text;
--> statement-breakpoint
ALTER TABLE "town"."civic_mandate_contestations"
  ADD CONSTRAINT "civic_mandate_contestations_reviewed_by_account_id_fkey"
  FOREIGN KEY ("reviewed_by_account_id") REFERENCES "town"."accounts"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "town"."civic_mandate_contestations"
  ADD CONSTRAINT "civic_mandate_contestations_review_note_valid"
  CHECK ("review_note" IS NULL OR char_length(btrim("review_note")) BETWEEN 1 AND 1000);
--> statement-breakpoint
ALTER TABLE "town"."civic_mandate_contestations"
  ADD CONSTRAINT "civic_mandate_contestations_review_state_consistent"
  CHECK (
    ("status" = 'pending' AND "reviewed_by_account_id" IS NULL AND "reviewed_at" IS NULL)
    OR ("status" IN ('upheld', 'rejected') AND "reviewed_by_account_id" IS NOT NULL AND "reviewed_at" IS NOT NULL)
  );
--> statement-breakpoint

-- §13: recording a stalled (14-day-escalated) verification-dispute
-- outcome. A distinct table from civic_verifications (the normal
-- threshold-reached record) because this operator action must never
-- touch current_stage/transitions/events per §14 — the process stays
-- "verification" forever; this is a public, permanent annotation only.
CREATE TABLE "town"."civic_verification_dispute_resolutions" (
  "process_id" uuid PRIMARY KEY NOT NULL,
  "outcome" text NOT NULL,
  "resolved_by_account_id" uuid NOT NULL,
  "resolved_at" timestamp with time zone NOT NULL,
  "review_note" text,
  CONSTRAINT "civic_verification_dispute_resolutions_outcome_valid"
    CHECK ("outcome" IN ('delivered', 'not_delivered')),
  CONSTRAINT "civic_verification_dispute_resolutions_review_note_valid"
    CHECK ("review_note" IS NULL OR char_length(btrim("review_note")) BETWEEN 1 AND 1000)
);
--> statement-breakpoint
ALTER TABLE "town"."civic_verification_dispute_resolutions"
  ADD CONSTRAINT "civic_verification_dispute_resolutions_process_id_fkey"
  FOREIGN KEY ("process_id") REFERENCES "town"."civic_processes"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "town"."civic_verification_dispute_resolutions"
  ADD CONSTRAINT "civic_verification_dispute_resolutions_resolved_by_account_id_fkey"
  FOREIGN KEY ("resolved_by_account_id") REFERENCES "town"."accounts"("id") ON DELETE RESTRICT;
--> statement-breakpoint

ALTER TABLE "town"."platform_audit_events" DROP CONSTRAINT "platform_audit_events_action_valid";
--> statement-breakpoint
ALTER TABLE "town"."platform_audit_events" ADD CONSTRAINT "platform_audit_events_action_valid" CHECK ("town"."platform_audit_events"."action" in (
		'operator_granted',
		'operator_revoked',
		'operator_role_changed',
		'account_suspended',
		'account_reactivated',
		'signal_hidden',
		'signal_unhidden',
		'status_viewed',
		'account_inspected',
		'audit_inspected',
		'email_inspected',
		'payment_inspected',
		'membership_granted',
		'membership_extended',
		'membership_cancellation_scheduled',
		'submission_rejected',
		'submission_restored',
		'discussion_contribution_hidden',
		'discussion_contribution_unhidden',
		'technical_errors_inspected',
		'uptime_inspected',
		'alerts_inspected',
		'alert_acknowledged',
		'backup_inspected',
		'backup_verified',
		'restore_inspected',
		'restore_drill_attested',
		'investigation_exported',
		'civic_content_hidden',
		'civic_content_unhidden',
		'civic_contestation_resolved',
		'civic_verification_dispute_resolved'
	));

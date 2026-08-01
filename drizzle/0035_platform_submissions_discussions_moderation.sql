ALTER TABLE "town"."signal_submissions" DROP CONSTRAINT "signal_submissions_status_valid";--> statement-breakpoint
ALTER TABLE "town"."signal_submissions" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "town"."signal_submissions" ADD COLUMN "reviewed_by_account_id" uuid;--> statement-breakpoint
ALTER TABLE "town"."signal_submissions" ADD COLUMN "review_reason" text;--> statement-breakpoint
ALTER TABLE "town"."signal_submissions" ADD CONSTRAINT "signal_submissions_reviewed_by_account_id_fkey" FOREIGN KEY ("reviewed_by_account_id") REFERENCES "town"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "town"."signal_submissions" ADD CONSTRAINT "signal_submissions_status_valid" CHECK ("town"."signal_submissions"."status" in ('pending_review', 'rejected'));--> statement-breakpoint
ALTER TABLE "town"."signal_submissions" ADD CONSTRAINT "signal_submissions_review_reason_valid" CHECK ("town"."signal_submissions"."review_reason" is null or "town"."signal_submissions"."review_reason" in ('immoral', 'abusive', 'spam', 'off_topic', 'illegal', 'other'));--> statement-breakpoint
ALTER TABLE "town"."signal_submissions" ADD CONSTRAINT "signal_submissions_review_state_consistent" CHECK ((
  ("town"."signal_submissions"."status" = 'pending_review'
    and "town"."signal_submissions"."reviewed_at" is null
    and "town"."signal_submissions"."reviewed_by_account_id" is null
    and "town"."signal_submissions"."review_reason" is null)
  or ("town"."signal_submissions"."status" = 'rejected'
    and "town"."signal_submissions"."reviewed_at" is not null
    and "town"."signal_submissions"."reviewed_by_account_id" is not null
    and "town"."signal_submissions"."review_reason" is not null)
));--> statement-breakpoint
CREATE INDEX "signal_submissions_status_created_at_idx" ON "town"."signal_submissions" USING btree ("status","created_at");--> statement-breakpoint
ALTER TABLE "town"."signal_discussion_contributions" ADD COLUMN "hidden_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "town"."signal_discussion_contributions" ADD COLUMN "hidden_reason" text;--> statement-breakpoint
ALTER TABLE "town"."signal_discussion_contributions" ADD COLUMN "hidden_by_account_id" uuid;--> statement-breakpoint
ALTER TABLE "town"."signal_discussion_contributions" ADD CONSTRAINT "signal_discussion_contributions_hidden_by_account_id_fkey" FOREIGN KEY ("hidden_by_account_id") REFERENCES "town"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "town"."signal_discussion_contributions" ADD CONSTRAINT "signal_discussion_contributions_hidden_reason_valid" CHECK ("town"."signal_discussion_contributions"."hidden_reason" is null or "town"."signal_discussion_contributions"."hidden_reason" in ('immoral', 'abusive', 'spam', 'off_topic', 'illegal', 'other'));--> statement-breakpoint
ALTER TABLE "town"."signal_discussion_contributions" ADD CONSTRAINT "signal_discussion_contributions_hidden_state_consistent" CHECK ((
  ("town"."signal_discussion_contributions"."hidden_at" is null
    and "town"."signal_discussion_contributions"."hidden_reason" is null
    and "town"."signal_discussion_contributions"."hidden_by_account_id" is null)
  or ("town"."signal_discussion_contributions"."hidden_at" is not null
    and "town"."signal_discussion_contributions"."hidden_reason" is not null
    and "town"."signal_discussion_contributions"."hidden_by_account_id" is not null)
));--> statement-breakpoint
CREATE INDEX "signal_discussion_contributions_hidden_created_at_idx" ON "town"."signal_discussion_contributions" USING btree ("hidden_at","created_at");--> statement-breakpoint
ALTER TABLE "town"."platform_audit_events" DROP CONSTRAINT "platform_audit_events_action_valid";--> statement-breakpoint
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
		'discussion_contribution_unhidden'
	));

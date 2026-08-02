CREATE TABLE "town"."platform_restore_drill_attestations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"drilled_at" timestamp with time zone NOT NULL,
	"drilled_by_account_id" uuid NOT NULL,
	"method" text NOT NULL,
	"outcome" text NOT NULL,
	"restore_point_at" timestamp with time zone,
	"note" text,
	"environment" text NOT NULL,
	"commit_sha" text,
	CONSTRAINT "platform_restore_drill_attestations_method_valid" CHECK ("town"."platform_restore_drill_attestations"."method" in ('railway_pitr_disposable_clone', 'railway_pitr_point_in_time')),
	CONSTRAINT "platform_restore_drill_attestations_outcome_valid" CHECK ("town"."platform_restore_drill_attestations"."outcome" in ('passed', 'failed')),
	CONSTRAINT "platform_restore_drill_attestations_note_bounded" CHECK ("town"."platform_restore_drill_attestations"."note" is null or char_length("town"."platform_restore_drill_attestations"."note") <= 240),
	CONSTRAINT "platform_restore_drill_attestations_restore_point_not_after_drilled" CHECK ("town"."platform_restore_drill_attestations"."restore_point_at" is null or "town"."platform_restore_drill_attestations"."restore_point_at" <= "town"."platform_restore_drill_attestations"."drilled_at")
);
--> statement-breakpoint
ALTER TABLE "town"."platform_restore_drill_attestations" ADD CONSTRAINT "platform_restore_drill_attestations_drilled_by_account_id_fkey" FOREIGN KEY ("drilled_by_account_id") REFERENCES "town"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "platform_restore_drill_attestations_drilled_at_idx" ON "town"."platform_restore_drill_attestations" USING btree ("drilled_at" DESC);--> statement-breakpoint
ALTER TABLE "town"."platform_alerts" DROP CONSTRAINT "platform_alerts_component_valid";--> statement-breakpoint
ALTER TABLE "town"."platform_alerts" ADD CONSTRAINT "platform_alerts_component_valid" CHECK ("town"."platform_alerts"."component" in ('api', 'database', 'email', 'stripe', 'backup', 'restore'));--> statement-breakpoint
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
		'discussion_contribution_unhidden',
		'technical_errors_inspected',
		'uptime_inspected',
		'alerts_inspected',
		'alert_acknowledged',
		'backup_inspected',
		'backup_verified',
		'restore_inspected',
		'restore_drill_attested'
	));

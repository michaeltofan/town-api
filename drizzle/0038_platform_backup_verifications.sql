CREATE TABLE "town"."platform_backup_verifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"verified_by_account_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"pitr_enabled" boolean NOT NULL,
	"retention_days" integer,
	"note" text,
	"environment" text NOT NULL,
	"commit_sha" text,
	CONSTRAINT "platform_backup_verifications_provider_valid" CHECK ("town"."platform_backup_verifications"."provider" in ('railway_postgres_pitr', 'none')),
	CONSTRAINT "platform_backup_verifications_retention_positive" CHECK ("town"."platform_backup_verifications"."retention_days" is null or ("town"."platform_backup_verifications"."retention_days" >= 1 and "town"."platform_backup_verifications"."retention_days" <= 365)),
	CONSTRAINT "platform_backup_verifications_note_bounded" CHECK ("town"."platform_backup_verifications"."note" is null or char_length("town"."platform_backup_verifications"."note") <= 240)
);
--> statement-breakpoint
ALTER TABLE "town"."platform_backup_verifications" ADD CONSTRAINT "platform_backup_verifications_verified_by_account_id_fkey" FOREIGN KEY ("verified_by_account_id") REFERENCES "town"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "platform_backup_verifications_verified_at_idx" ON "town"."platform_backup_verifications" USING btree ("verified_at" DESC);--> statement-breakpoint
ALTER TABLE "town"."platform_alerts" DROP CONSTRAINT "platform_alerts_component_valid";--> statement-breakpoint
ALTER TABLE "town"."platform_alerts" ADD CONSTRAINT "platform_alerts_component_valid" CHECK ("town"."platform_alerts"."component" in ('api', 'database', 'email', 'stripe', 'backup'));--> statement-breakpoint
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
		'backup_verified'
	));

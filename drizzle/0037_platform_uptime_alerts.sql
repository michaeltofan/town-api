CREATE TABLE "town"."platform_uptime_samples" (
	"id" uuid PRIMARY KEY NOT NULL,
	"sampled_at" timestamp with time zone NOT NULL,
	"api_status" text NOT NULL,
	"database_status" text NOT NULL,
	"email_status" text NOT NULL,
	"stripe_status" text NOT NULL,
	"overall_status" text NOT NULL,
	"environment" text NOT NULL,
	"service" text NOT NULL,
	"version" text NOT NULL,
	"commit_sha" text,
	CONSTRAINT "platform_uptime_samples_api_status_valid" CHECK ("town"."platform_uptime_samples"."api_status" in ('ok', 'degraded', 'fail', 'timeout', 'disabled', 'misconfigured')),
	CONSTRAINT "platform_uptime_samples_database_status_valid" CHECK ("town"."platform_uptime_samples"."database_status" in ('ok', 'degraded', 'fail', 'timeout', 'disabled', 'misconfigured')),
	CONSTRAINT "platform_uptime_samples_email_status_valid" CHECK ("town"."platform_uptime_samples"."email_status" in ('ok', 'degraded', 'fail', 'timeout', 'disabled', 'misconfigured')),
	CONSTRAINT "platform_uptime_samples_stripe_status_valid" CHECK ("town"."platform_uptime_samples"."stripe_status" in ('ok', 'degraded', 'fail', 'timeout', 'disabled', 'misconfigured')),
	CONSTRAINT "platform_uptime_samples_overall_status_valid" CHECK ("town"."platform_uptime_samples"."overall_status" in ('ok', 'degraded', 'fail', 'timeout', 'misconfigured'))
);
--> statement-breakpoint
CREATE INDEX "platform_uptime_samples_sampled_at_idx" ON "town"."platform_uptime_samples" USING btree ("sampled_at" DESC);--> statement-breakpoint
CREATE TABLE "town"."platform_alerts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"component" text NOT NULL,
	"status" text NOT NULL,
	"severity" text NOT NULL,
	"detail" text,
	"environment" text NOT NULL,
	"commit_sha" text,
	"resolved_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by_account_id" uuid,
	CONSTRAINT "platform_alerts_component_valid" CHECK ("town"."platform_alerts"."component" in ('api', 'database', 'email', 'stripe')),
	CONSTRAINT "platform_alerts_status_valid" CHECK ("town"."platform_alerts"."status" in ('degraded', 'fail', 'timeout', 'misconfigured')),
	CONSTRAINT "platform_alerts_severity_valid" CHECK ("town"."platform_alerts"."severity" in ('warning', 'critical')),
	CONSTRAINT "platform_alerts_detail_bounded" CHECK ("town"."platform_alerts"."detail" is null or char_length("town"."platform_alerts"."detail") <= 160),
	CONSTRAINT "platform_alerts_resolved_not_before_opened" CHECK ("town"."platform_alerts"."resolved_at" is null or "town"."platform_alerts"."resolved_at" >= "town"."platform_alerts"."opened_at"),
	CONSTRAINT "platform_alerts_ack_not_before_opened" CHECK ("town"."platform_alerts"."acknowledged_at" is null or "town"."platform_alerts"."acknowledged_at" >= "town"."platform_alerts"."opened_at"),
	CONSTRAINT "platform_alerts_ack_consistency" CHECK (
		("town"."platform_alerts"."acknowledged_at" is null and "town"."platform_alerts"."acknowledged_by_account_id" is null)
		or ("town"."platform_alerts"."acknowledged_at" is not null and "town"."platform_alerts"."acknowledged_by_account_id" is not null)
	)
);
--> statement-breakpoint
ALTER TABLE "town"."platform_alerts" ADD CONSTRAINT "platform_alerts_acknowledged_by_account_id_fkey" FOREIGN KEY ("acknowledged_by_account_id") REFERENCES "town"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "platform_alerts_opened_at_idx" ON "town"."platform_alerts" USING btree ("opened_at" DESC);--> statement-breakpoint
CREATE INDEX "platform_alerts_open_component_idx" ON "town"."platform_alerts" USING btree ("component") WHERE "resolved_at" is null;--> statement-breakpoint
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
		'alert_acknowledged'
	));

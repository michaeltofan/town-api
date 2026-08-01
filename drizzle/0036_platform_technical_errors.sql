CREATE TABLE "town"."platform_technical_errors" (
	"id" uuid PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"request_id" text NOT NULL,
	"method" text,
	"route" text,
	"status_code" integer NOT NULL,
	"error_code" text NOT NULL,
	"error_name" text,
	"message" text NOT NULL,
	"environment" text NOT NULL,
	"service" text NOT NULL,
	"version" text NOT NULL,
	"commit_sha" text,
	CONSTRAINT "platform_technical_errors_status_code_server" CHECK ("town"."platform_technical_errors"."status_code" >= 500 and "town"."platform_technical_errors"."status_code" <= 599),
	CONSTRAINT "platform_technical_errors_request_id_nonempty" CHECK (char_length("town"."platform_technical_errors"."request_id") > 0),
	CONSTRAINT "platform_technical_errors_error_code_nonempty" CHECK (char_length("town"."platform_technical_errors"."error_code") > 0),
	CONSTRAINT "platform_technical_errors_message_nonempty" CHECK (char_length("town"."platform_technical_errors"."message") > 0),
	CONSTRAINT "platform_technical_errors_message_bounded" CHECK (char_length("town"."platform_technical_errors"."message") <= 240),
	CONSTRAINT "platform_technical_errors_route_bounded" CHECK ("town"."platform_technical_errors"."route" is null or char_length("town"."platform_technical_errors"."route") <= 160),
	CONSTRAINT "platform_technical_errors_method_bounded" CHECK ("town"."platform_technical_errors"."method" is null or char_length("town"."platform_technical_errors"."method") <= 16),
	CONSTRAINT "platform_technical_errors_error_name_bounded" CHECK ("town"."platform_technical_errors"."error_name" is null or char_length("town"."platform_technical_errors"."error_name") <= 80)
);
--> statement-breakpoint
CREATE INDEX "platform_technical_errors_occurred_at_idx" ON "town"."platform_technical_errors" USING btree ("occurred_at" DESC);--> statement-breakpoint
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
		'technical_errors_inspected'
	));

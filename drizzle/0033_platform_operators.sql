CREATE TABLE "town"."platform_operators" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"role" text NOT NULL,
	"granted_at" timestamp with time zone NOT NULL,
	"granted_by_account_id" uuid,
	"revoked_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "platform_operators_role_valid" CHECK ("town"."platform_operators"."role" in ('viewer', 'investigator', 'moderator', 'account_admin', 'ops_admin', 'role_admin')),
	CONSTRAINT "platform_operators_revoked_not_before_granted" CHECK ("town"."platform_operators"."revoked_at" is null or "town"."platform_operators"."revoked_at" >= "town"."platform_operators"."granted_at")
);
--> statement-breakpoint
ALTER TABLE "town"."platform_operators" ADD CONSTRAINT "platform_operators_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "town"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "town"."platform_operators" ADD CONSTRAINT "platform_operators_granted_by_account_id_fkey" FOREIGN KEY ("granted_by_account_id") REFERENCES "town"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "platform_operators_active_role_idx" ON "town"."platform_operators" USING btree ("role") WHERE "revoked_at" is null;--> statement-breakpoint
CREATE TABLE "town"."platform_audit_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_account_id" uuid NOT NULL,
	"action" text NOT NULL,
	"target_account_id" uuid,
	"target_signal_id" uuid,
	"request_id" text,
	"metadata" jsonb,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "platform_audit_events_action_valid" CHECK ("town"."platform_audit_events"."action" in (
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
		'payment_inspected'
	))
);
--> statement-breakpoint
ALTER TABLE "town"."platform_audit_events" ADD CONSTRAINT "platform_audit_events_operator_account_id_fkey" FOREIGN KEY ("operator_account_id") REFERENCES "town"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "town"."platform_audit_events" ADD CONSTRAINT "platform_audit_events_target_account_id_fkey" FOREIGN KEY ("target_account_id") REFERENCES "town"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "town"."platform_audit_events" ADD CONSTRAINT "platform_audit_events_target_signal_id_fkey" FOREIGN KEY ("target_signal_id") REFERENCES "town"."signals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "platform_audit_events_occurred_at_idx" ON "town"."platform_audit_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "platform_audit_events_operator_occurred_idx" ON "town"."platform_audit_events" USING btree ("operator_account_id","occurred_at");--> statement-breakpoint
CREATE INDEX "platform_audit_events_target_account_occurred_idx" ON "town"."platform_audit_events" USING btree ("target_account_id","occurred_at");

ALTER TABLE "town"."membership_entitlements" DROP CONSTRAINT "membership_entitlements_source_valid";--> statement-breakpoint
ALTER TABLE "town"."membership_entitlements" ADD CONSTRAINT "membership_entitlements_source_valid" CHECK ("town"."membership_entitlements"."source" in ('test_fixture', 'stripe', 'google_play', 'admin'));--> statement-breakpoint
ALTER TABLE "town"."membership_source_events" DROP CONSTRAINT "membership_source_events_source_valid";--> statement-breakpoint
ALTER TABLE "town"."membership_source_events" ADD CONSTRAINT "membership_source_events_source_valid" CHECK ("town"."membership_source_events"."source" in ('test_fixture', 'stripe', 'google_play', 'admin'));--> statement-breakpoint
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
		'membership_cancellation_scheduled'
	));

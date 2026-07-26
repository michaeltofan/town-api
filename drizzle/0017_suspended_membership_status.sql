ALTER TABLE "town"."membership_entitlements" DROP CONSTRAINT "membership_entitlements_status_valid";--> statement-breakpoint
ALTER TABLE "town"."membership_entitlements" ADD CONSTRAINT "membership_entitlements_status_valid" CHECK ("town"."membership_entitlements"."status" in ('inactive', 'active', 'cancelling', 'expired', 'paid_pending_binding', 'suspended'));--> statement-breakpoint
ALTER TABLE "town"."membership_entitlements" DROP CONSTRAINT "membership_entitlements_state_invariants";--> statement-breakpoint
ALTER TABLE "town"."membership_entitlements" ADD CONSTRAINT "membership_entitlements_state_invariants" CHECK ((
        ("town"."membership_entitlements"."status" = 'inactive'
          and "town"."membership_entitlements"."access_until" is null
          and "town"."membership_entitlements"."cancel_at_period_end" = false)
        or ("town"."membership_entitlements"."status" = 'active'
          and "town"."membership_entitlements"."access_until" is not null
          and "town"."membership_entitlements"."cancel_at_period_end" = false
          and "town"."membership_entitlements"."activated_at" is not null
          and "town"."membership_entitlements"."expired_at" is null)
        or ("town"."membership_entitlements"."status" = 'cancelling'
          and "town"."membership_entitlements"."access_until" is not null
          and "town"."membership_entitlements"."cancel_at_period_end" = true
          and "town"."membership_entitlements"."cancellation_requested_at" is not null
          and "town"."membership_entitlements"."expired_at" is null)
        or ("town"."membership_entitlements"."status" = 'expired'
          and "town"."membership_entitlements"."access_until" is not null
          and "town"."membership_entitlements"."cancel_at_period_end" = false
          and "town"."membership_entitlements"."expired_at" is not null)
        or ("town"."membership_entitlements"."status" = 'paid_pending_binding'
          and "town"."membership_entitlements"."access_until" is not null
          and "town"."membership_entitlements"."cancel_at_period_end" = false
          and "town"."membership_entitlements"."activated_at" is null
          and "town"."membership_entitlements"."cancellation_requested_at" is null
          and "town"."membership_entitlements"."expired_at" is null)
        or ("town"."membership_entitlements"."status" = 'suspended'
          and "town"."membership_entitlements"."access_until" is not null
          and "town"."membership_entitlements"."expired_at" is null)
      ));

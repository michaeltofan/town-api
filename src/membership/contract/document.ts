function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort((a, b) => a.localeCompare(b))) {
      sorted[key] = sortValue(record[key]);
    }
    return sorted;
  }
  return value;
}

export function serializeMembershipContract(document: unknown): string {
  return `${JSON.stringify(sortValue(document), null, 2)}\n`;
}

export function generateMembershipContractDocument(): unknown {
  return {
    contractVersion: '1.0.0',
    title: 'TOWN Membership Foundation V1 — Slice 1',
    description:
      'Contract for the membership entitlement runtime, civic access derivation, source-event idempotency ledger, participant signal confirmation, and session-authenticated membership inventory read. Membership is a separate foundation from account identity and civic actors. This Slice 1 contract does not own Stripe Checkout, Customer Portal, or webhook routes; those are implemented by Membership Foundation V1 Slice 2 (billing foundation contract). JWTs and production local verification runtime remain out of scope here. Stripe is the sole membership payment provider for the current web launch; Google Play, Flutter, Apple In-App Purchase, and native app-store distribution are outside the current critical path.',
    status: 'implemented',
    implementedLiveRoutes: true,
    slice: 'membership_entitlement_and_civic_access_runtime',
    domainSeparation: {
      accountIdentity:
        'Account shell, verified email, passkeys, challenges, recovery grants; active account does not imply paid membership',
      civicActor:
        'Local civic participation identity linked 1:1 to an account; membership does not create or link actors',
      authenticatedSession:
        'Opaque server-side account_sessions; not membership or civic entitlement',
      membershipEntitlement:
        'Separate foundation stored in town.membership_entitlements and town.membership_source_events',
      localVerification: 'Out of scope',
      stripe:
        'Out of scope for this Slice 1 entitlement contract; Stripe SDK/network integration is implemented in Membership Foundation V1 Slice 2 (billing foundation contract) and is the sole web-launch payment path',
    },
    entitlement: {
      table: 'town.membership_entitlements',
      uniquePerAccount: true,
      statuses: [
        'inactive',
        'active',
        'cancelling',
        'expired',
        'paid_pending_binding',
        'suspended',
      ],
      sources: ['test_fixture', 'stripe', 'google_play'],
      versioning: {
        column: 'version',
        semantics: 'Monotonically increases by 1 on each applied transition',
      },
      providerReferences: {
        columns: ['source_customer_id', 'source_subscription_id'],
        publicExposure: 'never exposed in any API response body',
      },
      stateInvariants: [
        'inactive => access_until null and cancel_at_period_end false',
        'active => access_until not null and cancel_at_period_end false and activated_at not null and expired_at null',
        'cancelling => access_until not null and cancel_at_period_end true and cancellation_requested_at not null and expired_at null',
        'expired => access_until not null and cancel_at_period_end false and expired_at not null',
        'paid_pending_binding => access_until not null and cancel_at_period_end false and activated_at null and cancellation_requested_at null and expired_at null',
        'suspended => access_until not null and expired_at null',
      ],
    },
    sourceEvents: {
      table: 'town.membership_source_events',
      uniqueness: ['source', 'source_event_id'],
      eventTypes: [
        'activate',
        'schedule_cancellation',
        'expire',
        'reactivate',
        'provision_paid_pending_binding',
        'finalize_paid_pending_binding',
        'restore',
      ],
      results: ['applied', 'replayed', 'rejected', 'stale'],
      payloadHash: {
        algorithm: 'sha256',
        canonicalKeyOrder: [
          'accessUntil',
          'accountId',
          'cancelAtPeriodEnd',
          'effectiveAt',
          'eventType',
          'googlePlayPackageName',
          'googlePlayPurchaseToken',
          'googlePlaySubscriptionId',
          'source',
          'sourceCustomerId',
          'sourceEventId',
          'sourceSubscriptionId',
        ],
        excludes: [
          'email',
          'sessionToken',
          'ipAddress',
          'stripeWebhookSecret',
          'paymentMethod',
          'card',
        ],
      },
      idempotency: [
        'Same (source, source_event_id) with matching payload_hash returns replayed and never re-mutates the entitlement',
        'Same (source, source_event_id) with divergent payload_hash returns rejected and never mutates the entitlement',
        'Duplicate insertion races are recovered as replayed or rejected via the source_event_unique constraint',
      ],
    },
    accessLevels: {
      values: ['visitor', 'read_only', 'participant'],
      derivation: [
        'visitor when no session is present',
        'read_only when a session is present but participant preconditions are not all met',
        'participant only when the account is active, the entitlement is temporally valid with status active or cancelling, a linked civic actor exists for the request community, and local eligibility is eligible',
        'paid_pending_binding never grants participant access; payment alone is insufficient without final community binding',
      ],
    },
    googlePlayPreBinding: {
      table: 'town.google_play_purchase_links',
      source: 'google_play',
      provisionedStatus: 'paid_pending_binding',
      internalOperation: 'provisionGooglePlayPaidPendingBinding',
      publicRoutes: [],
      trustBoundary:
        'Input is trusted only after the server-side Google Play verifier validates the purchase via Android Publisher subscriptionsv2.get and then calls the internal provisioner; the session-authenticated purchase ingress never bypasses verification',
      participation: 'paid_pending_binding grants no civic participation',
    },
    googlePlayVerification: {
      featureFlag: 'GOOGLE_PLAY_BILLING_ENABLED',
      featureFlagDefault: false,
      api: 'purchases.subscriptionsv2.get',
      adapter: 'TownGooglePlayAndroidPublisherAdapter',
      internalOperation: 'verifyAndProvisionGooglePlayPurchase',
      publicRoutes: ['POST /v1/billing/google-play/purchases'],
      requiredConfig: [
        'GOOGLE_PLAY_PACKAGE_NAME',
        'GOOGLE_PLAY_SUBSCRIPTION_ID',
        'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON',
      ],
      acceptedSubscriptionStates: ['SUBSCRIPTION_STATE_ACTIVE'],
      failClosed: [
        'disabled when GOOGLE_PLAY_BILLING_ENABLED is false',
        'rejected when Android Publisher verification fails or returns a non-active subscription',
        'rejected when productId or packageName does not match configured values',
        'never calls provisionGooglePlayPaidPendingBinding unless verification succeeds',
        'never acknowledges until provision returns applied or replayed',
      ],
      exclusions: [
        'RTDN',
        'Pub/Sub',
        'voided purchases',
        'refunds',
        'binding finalization to active',
        'Play Billing client',
        'Flutter',
      ],
    },
    googlePlayPurchaseAcknowledgement: {
      api: 'purchases.subscriptions.acknowledge',
      adapter: 'TownGooglePlayAndroidPublisherAdapter',
      internalOperation: 'verifyAndProvisionGooglePlayPurchase',
      when: 'only after verifyAndProvisionGooglePlayPurchase reaches durable applied or replayed provision',
      neverWhen: [
        'failed verification',
        'rejected purchase',
        'cross-account purchase-token protection',
        'transaction rollback',
        'provisioning failure',
      ],
      alreadyAcknowledged:
        'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED skips the acknowledge call; Google acknowledge is otherwise treated as idempotent without a local persistence marker',
      persistence:
        'no schema change; google_play_purchase_links remains purchase-token correlation only',
      failClosed: [
        'acknowledgement transport or non-success Google status fails the request after durable provision so clients can retry',
        'never exposes purchase tokens or Google acknowledgement payloads',
      ],
      exclusions: [
        'RTDN',
        'Pub/Sub',
        'voided purchases',
        'refunds',
        'binding finalization to active',
        'Play Billing client',
        'Flutter',
      ],
    },
    googlePlayPurchaseIngress: {
      route: 'POST /v1/billing/google-play/purchases',
      featureFlag: 'GOOGLE_PLAY_BILLING_ENABLED',
      featureFlagDefault: false,
      auth: 'active web or mobile Session only; SetupGrant, RecoveryGrant, and Bearer rejected',
      internalOperation: 'verifyAndProvisionGooglePlayPurchase',
      requestFields: ['purchaseToken', 'optional packageName', 'optional subscriptionId'],
      responsePolicy: [
        'returns applied or replayed with bounded membership status only',
        'never returns purchase tokens',
        'never returns Google verification payloads or provider identifiers',
      ],
      disabledBehavior: 'route returns 404 when GOOGLE_PLAY_BILLING_ENABLED is false',
      exclusions: [
        'RTDN',
        'Pub/Sub',
        'voided purchases',
        'refunds',
        'binding finalization to active',
        'Play Billing client',
        'Flutter',
      ],
    },
    localEligibility: {
      values: ['eligible', 'not_verified', 'expired', 'mismatched_community', 'unavailable'],
      failClosedDefault: 'unavailable',
      featureFlag: 'LOCAL_ELIGIBILITY_ENABLED',
      featureFlagDefault: false,
      disabledBehavior:
        'resolver always returns unavailable (byte-identical to prior fail-closed default)',
      enabledDerivation: [
        'not_verified when actor is null, community_id is null, or local_eligibility_verified_at is null',
        'mismatched_community when actor.community_id differs from the community being evaluated',
        'eligible when actor.community_id matches the evaluated community and local_eligibility_verified_at is set',
        'expired is never returned by the runtime resolver',
      ],
      setOnceBindRoute: 'PUT /v1/account/eligibility',
      setOnceSemantics: [
        'null community_id creates the binding and sets local_eligibility_verified_at',
        'same community_id is idempotent and does not refresh verified_at',
        'different community_id returns 409 LOCAL_ELIGIBILITY_ALREADY_BOUND for non-owners',
        'accounts.is_owner=true may transfer to a different community and refreshes local_eligibility_verified_at',
        'owner is read only from the locked account row; never from the request body',
      ],
      trustLimitation:
        'Request body community is a client assertion; raw location data never reaches the server; flag must remain false for untrusted clients until independent validation or controlled access exists',
      productionBehavior:
        'disabled by default via LOCAL_ELIGIBILITY_ENABLED=false; when disabled, resolver returns unavailable',
      testBehavior: 'test-only resolver may return eligible for participant coverage',
      actorColumn: 'town.actors.local_eligibility_verified_at',
    },
    transitions: {
      activate: {
        allowedFromStatuses: ['absent', 'inactive', 'expired', 'cancelling'],
        rejectsWhen: [
          'account is closed',
          'access_until is not provided',
          'access_until is not strictly greater than effective_at',
        ],
        stalenessRules: [
          'active with a lower or equal proposed access_until is treated as stale, not applied',
          'active with an older effective_at than the current updated_at is treated as stale',
        ],
        successOutcome: {
          status: 'active',
          cancelAtPeriodEnd: false,
          activatedAtSetTo: 'effective_at',
          expiredAt: null,
        },
      },
      scheduleCancellation: {
        allowedFromStatuses: ['active'],
        stalenessRules: ['older cancellation_requested_at events are marked stale'],
        successOutcome: {
          status: 'cancelling',
          cancelAtPeriodEnd: true,
          cancellationRequestedAtSetTo: 'effective_at',
          accessUntilPreserved: true,
        },
      },
      reactivate: {
        allowedFromStatuses: ['cancelling'],
        rejectsWhen: [
          'no entitlement exists',
          'entitlement is not currently cancelling',
          'access_until has already elapsed at effective_at',
        ],
        successOutcome: {
          status: 'active',
          cancelAtPeriodEnd: false,
          cancellationRequestedAtClearedTo: null,
        },
      },
      expire: {
        allowedFromStatuses: ['active', 'cancelling'],
        rejectsWhen: ['no entitlement exists', 'effective_at precedes access_until (too early)'],
        stalenessRules: ['older effective_at than current expired_at is treated as stale'],
        successOutcome: {
          status: 'expired',
          cancelAtPeriodEnd: false,
          expiredAtSetTo: 'effective_at',
          accessUntilPreserved: true,
        },
      },
      provisionPaidPendingBinding: {
        source: 'google_play',
        allowedFromStatuses: ['absent', 'inactive', 'expired'],
        rejectsWhen: [
          'account is closed',
          'access_until is not provided',
          'access_until is not strictly greater than effective_at',
          'purchase token is already correlated',
          'entitlement is already active, cancelling, or paid_pending_binding',
        ],
        successOutcome: {
          status: 'paid_pending_binding',
          cancelAtPeriodEnd: false,
          activatedAt: null,
          expiredAt: null,
          grantsParticipation: false,
        },
        publicRoutes: [],
      },
      finalizePaidPendingBinding: {
        eventType: 'finalize_paid_pending_binding',
        allowedFromStatuses: ['paid_pending_binding'],
        rejectsWhen: [
          'account is closed',
          'entitlement is missing',
          'entitlement is not paid_pending_binding',
          'access_until is missing or not strictly greater than effective_at',
          'proposed access_until does not match the entitlement access_until',
        ],
        preconditions: [
          'civic actor community binding is set for the target community',
          'local_eligibility_verified_at is set',
        ],
        successOutcome: {
          status: 'active',
          cancelAtPeriodEnd: false,
          activatedAtSetTo: 'effective_at',
          accessUntilPreserved: true,
          expiredAt: null,
        },
        trigger:
          'after successful PUT /v1/account/eligibility community binding (create or same-community idempotent confirm)',
        neverFrom: [
          'Google Play purchase ingress',
          'verifyAndProvisionGooglePlayPurchase',
          'activateMembership',
        ],
      },
    },
    paidPendingBindingFinalization: {
      internalOperation: 'maybeFinalizePaidPendingBindingAfterCommunityBind',
      transition: 'finalizePaidPendingBindingMembership',
      eventType: 'finalize_paid_pending_binding',
      fromStatus: 'paid_pending_binding',
      toStatus: 'active',
      triggerRoute: 'PUT /v1/account/eligibility',
      schemaChange:
        'membership_source_events_event_type_valid expanded to include finalize_paid_pending_binding only',
      exclusions: [
        'RTDN',
        'Pub/Sub',
        'voided purchases',
        'refunds',
        'subscription renewal',
        'Play Billing client',
        'Flutter',
      ],
    },
    reconcile: {
      module: 'src/membership/reconcile.ts',
      selects:
        'entitlements in status active or cancelling with non-null access_until at or before now',
      concurrency: 'FOR UPDATE SKIP LOCKED with a bounded batch size',
      idempotent: true,
      neverExpiresFuture: true,
    },
    routes: {
      publicMembershipRoutes: ['GET /v1/account/membership'],
      publicMembershipMutationRoutes: [],
      localEligibilityBindRoute: 'PUT /v1/account/eligibility',
      participantSignalConfirmation: 'PUT /v1/signals/:signalId/confirmation',
      controlledSignalConfirmationRead: 'GET /v1/signals/:signalId/confirmation',
    },
    participantPolicy: {
      requiresActiveSession: true,
      rejectsAuthorizationSchemes: ['SetupGrant', 'RecoveryGrant', 'Bearer'],
      rejectsControlKeyOnPut: true,
      requiresParticipantAccess: true,
      neverReassignsControlledActorConfirmations: true,
      neverLinksControlledActor: true,
      denialErrorCode: 'CIVIC_PARTICIPATION_NOT_AUTHORIZED',
      denialMetadata:
        'bounded denial reason categories only; no signal, actor, or entitlement identifiers',
    },
    identitySecurityEvents: {
      added: [
        'membership_created',
        'membership_activated',
        'membership_cancellation_scheduled',
        'membership_reactivated',
        'membership_expired',
        'membership_suspended',
        'membership_restored',
        'membership_paid_pending_binding_provisioned',
        'membership_event_replayed',
        'membership_event_rejected',
        'civic_participation_denied',
      ],
      metadataPolicy: [
        'Bounded scalar categories only',
        'Never contains raw provider payloads',
        'Never contains raw session tokens, cookies, or Authorization headers',
      ],
    },
    rateLimits: {
      table: 'town.ceremony_rate_limits',
      scope: 'membership_inventory_account',
      windowMinutes: 15,
      limit: 60,
    },
    stripeBoundary: {
      package:
        'installed as stripe@22.3.2; owned by Membership Foundation V1 Slice 2 billing foundation contract',
      network:
        'called only by the Slice 2 billing runtime when STRIPE_BILLING_ENABLED is true; Stripe is the sole membership payment provider for the current web launch',
      customerIds: 'reserved column only; never exposed in API responses',
      subscriptionIds: 'reserved column only; never exposed in API responses',
      webhookHandler:
        'implemented at POST /v1/billing/stripe/webhook by the Slice 2 billing runtime',
    },
    explicitExclusions: [
      'payment card handling',
      'production email provider',
      'JWTs',
      'membership mutation routes other than the session-authenticated Google Play purchase ingress',
      'membership pricing, catalog, or checkout owned by this Slice 1 contract (Stripe Checkout/Portal live under the Slice 2 billing contract)',
      'local verification runtime',
      'Google Play RTDN membership apply / voided purchases / refunds',
      'subscription renewal owned by this Slice 1 contract',
      'Flutter client development',
      'Apple In-App Purchase / StoreKit / app-store distribution',
      'native Android/iOS application launch as the current critical path',
      'Redis',
      'Railway',
      'web frontend integration owned by town-public',
      'deployment',
    ],
    testCommands: [
      'npm test',
      'npm run test:integration',
      'npm run db:check',
      'npm run db:migrate:test',
      'npm run openapi:check',
      'npm run identity:contract:check',
      'npm run auth:contract:check',
      'npm run membership:contract:check',
    ],
  };
}

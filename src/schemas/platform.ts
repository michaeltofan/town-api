import { Type, type Static } from '@sinclair/typebox';
import { SignalHideReasonSchema } from './signal-moderation.js';

export const PlatformOperatorRoleSchema = Type.Union(
  [
    Type.Literal('viewer'),
    Type.Literal('investigator'),
    Type.Literal('moderator'),
    Type.Literal('account_admin'),
    Type.Literal('ops_admin'),
    Type.Literal('role_admin'),
  ],
  { $id: 'PlatformOperatorRole' },
);

export const PlatformAccountStatusSchema = Type.Union(
  [
    Type.Literal('pending_email'),
    Type.Literal('pending_password'),
    Type.Literal('pending_passkey'),
    Type.Literal('active'),
    Type.Literal('suspended'),
    Type.Literal('closed'),
  ],
  { $id: 'PlatformAccountStatus' },
);

export const PlatformSessionResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        accountId: Type.String({ format: 'uuid' }),
        role: PlatformOperatorRoleSchema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'PlatformSessionResponse' },
);

export const PlatformComponentStatusSchema = Type.Union([
  Type.Literal('ok'),
  Type.Literal('degraded'),
  Type.Literal('fail'),
  Type.Literal('timeout'),
  Type.Literal('disabled'),
  Type.Literal('misconfigured'),
]);

export const PlatformComponentCheckSchema = Type.Object(
  {
    status: PlatformComponentStatusSchema,
    detail: Type.Union([Type.String({ maxLength: 160 }), Type.Null()]),
  },
  { additionalProperties: false },
);

export const PlatformStatusResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        health: Type.Object(
          {
            live: Type.Literal('ok'),
            ready: Type.Union([Type.Literal('ready'), Type.Literal('not_ready')]),
            checks: Type.Object(
              {
                config: Type.Union([Type.Literal('ok'), Type.Literal('fail')]),
                database: Type.Union([
                  Type.Literal('ok'),
                  Type.Literal('fail'),
                  Type.Literal('timeout'),
                ]),
                migrations: Type.Union([
                  Type.Literal('ok'),
                  Type.Literal('fail'),
                  Type.Literal('unknown'),
                ]),
              },
              { additionalProperties: false },
            ),
            build: Type.Object(
              {
                service: Type.Literal('town-api'),
                environment: Type.Union([
                  Type.Literal('development'),
                  Type.Literal('test'),
                  Type.Literal('staging'),
                  Type.Literal('production'),
                ]),
                version: Type.String(),
                commitSha: Type.Union([Type.String(), Type.Null()]),
              },
              { additionalProperties: false },
            ),
          },
          { additionalProperties: false },
        ),
        components: Type.Object(
          {
            api: PlatformComponentCheckSchema,
            database: PlatformComponentCheckSchema,
            email: PlatformComponentCheckSchema,
            stripe: PlatformComponentCheckSchema,
          },
          { additionalProperties: false },
        ),
        counts: Type.Object(
          {
            accounts: Type.Object(
              {
                total: Type.Integer({ minimum: 0 }),
                active: Type.Integer({ minimum: 0 }),
                suspended: Type.Integer({ minimum: 0 }),
                pending: Type.Integer({ minimum: 0 }),
              },
              { additionalProperties: false },
            ),
            memberships: Type.Object(
              {
                total: Type.Integer({ minimum: 0 }),
                active: Type.Integer({ minimum: 0 }),
                suspended: Type.Integer({ minimum: 0 }),
                expired: Type.Integer({ minimum: 0 }),
              },
              { additionalProperties: false },
            ),
            signals: Type.Object(
              {
                published: Type.Integer({ minimum: 0 }),
                hidden: Type.Integer({ minimum: 0 }),
              },
              { additionalProperties: false },
            ),
            submissions: Type.Object(
              {
                pendingReview: Type.Integer({ minimum: 0 }),
              },
              { additionalProperties: false },
            ),
            communities: Type.Object(
              {
                total: Type.Integer({ minimum: 0 }),
              },
              { additionalProperties: false },
            ),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'PlatformStatusResponse' },
);

export const PlatformAccountsQuerySchema = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50 })),
    status: Type.Optional(PlatformAccountStatusSchema),
    email: Type.Optional(Type.String({ minLength: 3, maxLength: 320 })),
    q: Type.Optional(Type.String({ minLength: 1, maxLength: 320 })),
  },
  { additionalProperties: false, $id: 'PlatformAccountsQuery' },
);

export const PlatformAccountItemSchema = Type.Object(
  {
    accountId: Type.String({ format: 'uuid' }),
    status: PlatformAccountStatusSchema,
    isOwner: Type.Boolean(),
    email: Type.Union([Type.String(), Type.Null()]),
    communitySlug: Type.Union([Type.String(), Type.Null()]),
    membershipStatus: Type.Union([Type.String(), Type.Null()]),
    suspendedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    createdAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false, $id: 'PlatformAccountItem' },
);

export const PlatformAccountsResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        accounts: Type.Array(PlatformAccountItemSchema),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'PlatformAccountsResponse' },
);

export const PlatformAccountIdParamsSchema = Type.Object(
  {
    accountId: Type.String({ format: 'uuid' }),
  },
  { additionalProperties: false, $id: 'PlatformAccountIdParams' },
);

export const PlatformAccountDetailResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        accountId: Type.String({ format: 'uuid' }),
        status: PlatformAccountStatusSchema,
        isOwner: Type.Boolean(),
        email: Type.Union([Type.String(), Type.Null()]),
        communitySlug: Type.Union([Type.String(), Type.Null()]),
        membershipStatus: Type.Union([Type.String(), Type.Null()]),
        suspendedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
        accountReadyAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
        closedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
        createdAt: Type.String({ format: 'date-time' }),
        updatedAt: Type.String({ format: 'date-time' }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'PlatformAccountDetailResponse' },
);

export const PlatformAccountSuspendBodySchema = Type.Object(
  {
    reason: SignalHideReasonSchema,
  },
  { additionalProperties: false, $id: 'PlatformAccountSuspendBody' },
);

export const PlatformAccountActionResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        accountId: Type.String({ format: 'uuid' }),
        status: PlatformAccountStatusSchema,
        suspendedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
        changed: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'PlatformAccountActionResponse' },
);

export const PlatformCommunitiesResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        communities: Type.Array(
          Type.Object(
            {
              id: Type.String({ format: 'uuid' }),
              slug: Type.String(),
              displayName: Type.String(),
              countryCode: Type.String(),
              cityName: Type.String(),
              status: Type.String(),
              boundAccounts: Type.Integer({ minimum: 0 }),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'PlatformCommunitiesResponse' },
);

export const PlatformMembershipsQuerySchema = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50 })),
    status: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    q: Type.Optional(Type.String({ minLength: 1, maxLength: 320 })),
  },
  { additionalProperties: false, $id: 'PlatformMembershipsQuery' },
);

export const PlatformMembershipAllowedActionSchema = Type.Union(
  [Type.Literal('extend'), Type.Literal('schedule_cancellation')],
  { $id: 'PlatformMembershipAllowedAction' },
);

export const PlatformMembershipsResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        memberships: Type.Array(
          Type.Object(
            {
              accountId: Type.String({ format: 'uuid' }),
              status: Type.String(),
              source: Type.String(),
              accessUntil: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
              activatedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
              cancellationRequestedAt: Type.Union([
                Type.String({ format: 'date-time' }),
                Type.Null(),
              ]),
              cancelAtPeriodEnd: Type.Boolean(),
              expiredAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
              updatedAt: Type.String({ format: 'date-time' }),
              email: Type.Union([Type.String(), Type.Null()]),
              allowedActions: Type.Array(PlatformMembershipAllowedActionSchema),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'PlatformMembershipsResponse' },
);

export const PlatformMembershipReasonSchema = Type.String({ minLength: 3, maxLength: 256 });

export const PlatformMembershipGrantBodySchema = Type.Object(
  {
    accountId: Type.String({ format: 'uuid' }),
    accessUntil: Type.String({ format: 'date-time' }),
    reason: PlatformMembershipReasonSchema,
    idempotencyKey: Type.String({ format: 'uuid' }),
  },
  { additionalProperties: false, $id: 'PlatformMembershipGrantBody' },
);

export const PlatformMembershipExtendBodySchema = Type.Object(
  {
    accessUntil: Type.String({ format: 'date-time' }),
    reason: PlatformMembershipReasonSchema,
    idempotencyKey: Type.String({ format: 'uuid' }),
  },
  { additionalProperties: false, $id: 'PlatformMembershipExtendBody' },
);

export const PlatformMembershipScheduleCancellationBodySchema = Type.Object(
  {
    reason: PlatformMembershipReasonSchema,
    idempotencyKey: Type.String({ format: 'uuid' }),
  },
  { additionalProperties: false, $id: 'PlatformMembershipScheduleCancellationBody' },
);

export const PlatformMembershipActionResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        accountId: Type.String({ format: 'uuid' }),
        status: Type.String(),
        source: Type.String(),
        accessUntil: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
        activatedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
        cancellationRequestedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
        cancelAtPeriodEnd: Type.Boolean(),
        expiredAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
        changed: Type.Boolean(),
        allowedActions: Type.Array(PlatformMembershipAllowedActionSchema),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'PlatformMembershipActionResponse' },
);

export const PlatformSignalsQuerySchema = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50 })),
    hiddenOnly: Type.Optional(Type.Boolean({ default: false })),
  },
  { additionalProperties: false, $id: 'PlatformSignalsQuery' },
);

export const PlatformSignalsResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        signals: Type.Array(
          Type.Object(
            {
              id: Type.String({ format: 'uuid' }),
              slug: Type.String(),
              headline: Type.String(),
              communitySlug: Type.String(),
              authorDisplayName: Type.String(),
              authorAccountId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
              hidden: Type.Boolean(),
              hiddenAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
              hiddenReason: Type.Union([Type.String(), Type.Null()]),
              publishedAt: Type.String({ format: 'date-time' }),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'PlatformSignalsResponse' },
);

export const PlatformSignalIdParamsSchema = Type.Object(
  {
    signalId: Type.String({ format: 'uuid' }),
  },
  { additionalProperties: false, $id: 'PlatformSignalIdParams' },
);

export const PlatformSignalHideBodySchema = Type.Object(
  {
    reason: SignalHideReasonSchema,
  },
  { additionalProperties: false, $id: 'PlatformSignalHideBody' },
);

export const PlatformSignalActionResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        signalId: Type.String({ format: 'uuid' }),
        hidden: Type.Boolean(),
        hiddenAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
        hiddenReason: Type.Union([Type.String(), Type.Null()]),
        changed: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'PlatformSignalActionResponse' },
);

export const PlatformSubmissionAllowedActionSchema = Type.Union(
  [Type.Literal('reject'), Type.Literal('restore')],
  { $id: 'PlatformSubmissionAllowedAction' },
);

export const PlatformSubmissionsQuerySchema = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50 })),
    status: Type.Optional(Type.Union([Type.Literal('pending_review'), Type.Literal('rejected')])),
    communitySlug: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    q: Type.Optional(Type.String({ minLength: 1, maxLength: 320 })),
  },
  { additionalProperties: false, $id: 'PlatformSubmissionsQuery' },
);

export const PlatformSubmissionsResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        submissions: Type.Array(
          Type.Object(
            {
              id: Type.String({ format: 'uuid' }),
              accountId: Type.String({ format: 'uuid' }),
              communitySlug: Type.String(),
              headline: Type.String(),
              body: Type.String(),
              status: Type.Union([Type.Literal('pending_review'), Type.Literal('rejected')]),
              reviewReason: Type.Union([Type.String(), Type.Null()]),
              reviewedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
              reviewedByAccountId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
              createdAt: Type.String({ format: 'date-time' }),
              updatedAt: Type.String({ format: 'date-time' }),
              allowedActions: Type.Array(PlatformSubmissionAllowedActionSchema),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'PlatformSubmissionsResponse' },
);

export const PlatformSubmissionIdParamsSchema = Type.Object(
  {
    submissionId: Type.String({ format: 'uuid' }),
  },
  { additionalProperties: false, $id: 'PlatformSubmissionIdParams' },
);

export const PlatformSubmissionRejectBodySchema = Type.Object(
  {
    reason: SignalHideReasonSchema,
  },
  { additionalProperties: false, $id: 'PlatformSubmissionRejectBody' },
);

export const PlatformSubmissionActionResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        id: Type.String({ format: 'uuid' }),
        accountId: Type.String({ format: 'uuid' }),
        communitySlug: Type.String(),
        status: Type.Union([Type.Literal('pending_review'), Type.Literal('rejected')]),
        reviewReason: Type.Union([Type.String(), Type.Null()]),
        reviewedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
        reviewedByAccountId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
        changed: Type.Boolean(),
        allowedActions: Type.Array(PlatformSubmissionAllowedActionSchema),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'PlatformSubmissionActionResponse' },
);

export const PlatformSubmissionDetailResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        id: Type.String({ format: 'uuid' }),
        accountId: Type.String({ format: 'uuid' }),
        communitySlug: Type.String(),
        communityId: Type.String({ format: 'uuid' }),
        headline: Type.String(),
        body: Type.String(),
        status: Type.Union([Type.Literal('pending_review'), Type.Literal('rejected')]),
        reviewReason: Type.Union([Type.String(), Type.Null()]),
        reviewedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
        reviewedByAccountId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
        createdAt: Type.String({ format: 'date-time' }),
        updatedAt: Type.String({ format: 'date-time' }),
        allowedActions: Type.Array(PlatformSubmissionAllowedActionSchema),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'PlatformSubmissionDetailResponse' },
);

export const PlatformDiscussionAllowedActionSchema = Type.Union(
  [Type.Literal('hide'), Type.Literal('unhide')],
  { $id: 'PlatformDiscussionAllowedAction' },
);

export const PlatformDiscussionsQuerySchema = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50 })),
    hiddenOnly: Type.Optional(Type.Boolean({ default: false })),
    communitySlug: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    q: Type.Optional(Type.String({ minLength: 1, maxLength: 320 })),
  },
  { additionalProperties: false, $id: 'PlatformDiscussionsQuery' },
);

export const PlatformDiscussionsResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        contributions: Type.Array(
          Type.Object(
            {
              contributionId: Type.String({ format: 'uuid' }),
              sessionId: Type.String({ format: 'uuid' }),
              signalId: Type.String({ format: 'uuid' }),
              signalSlug: Type.String(),
              communitySlug: Type.String(),
              intent: Type.String(),
              body: Type.String(),
              accountId: Type.String({ format: 'uuid' }),
              hidden: Type.Boolean(),
              hiddenAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
              hiddenReason: Type.Union([Type.String(), Type.Null()]),
              createdAt: Type.String({ format: 'date-time' }),
              allowedActions: Type.Array(PlatformDiscussionAllowedActionSchema),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'PlatformDiscussionsResponse' },
);

export const PlatformDiscussionContributionIdParamsSchema = Type.Object(
  {
    contributionId: Type.String({ format: 'uuid' }),
  },
  { additionalProperties: false, $id: 'PlatformDiscussionContributionIdParams' },
);

export const PlatformDiscussionHideBodySchema = Type.Object(
  {
    reason: SignalHideReasonSchema,
  },
  { additionalProperties: false, $id: 'PlatformDiscussionHideBody' },
);

export const PlatformDiscussionActionResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        contributionId: Type.String({ format: 'uuid' }),
        signalId: Type.String({ format: 'uuid' }),
        accountId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
        hidden: Type.Boolean(),
        hiddenAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
        hiddenReason: Type.Union([Type.String(), Type.Null()]),
        changed: Type.Boolean(),
        allowedActions: Type.Array(PlatformDiscussionAllowedActionSchema),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'PlatformDiscussionActionResponse' },
);

export const PlatformAuditQuerySchema = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50 })),
    operatorAccountId: Type.Optional(Type.String({ format: 'uuid' })),
    targetAccountId: Type.Optional(Type.String({ format: 'uuid' })),
    action: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    from: Type.Optional(Type.String({ format: 'date-time' })),
    to: Type.Optional(Type.String({ format: 'date-time' })),
  },
  { additionalProperties: false, $id: 'PlatformAuditQuery' },
);

export const PlatformAuditResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        events: Type.Array(
          Type.Object(
            {
              id: Type.String({ format: 'uuid' }),
              operatorAccountId: Type.String({ format: 'uuid' }),
              action: Type.String(),
              targetAccountId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
              targetSignalId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
              requestId: Type.Union([Type.String(), Type.Null()]),
              metadata: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]),
              occurredAt: Type.String({ format: 'date-time' }),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'PlatformAuditResponse' },
);

export const PlatformAccountEmailsResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        emails: Type.Array(
          Type.Object(
            {
              id: Type.String({ format: 'uuid' }),
              emailOriginal: Type.String(),
              emailNormalized: Type.String(),
              isPrimary: Type.Boolean(),
              verifiedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
              revokedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
              createdAt: Type.String({ format: 'date-time' }),
            },
            { additionalProperties: false },
          ),
        ),
        challenges: Type.Array(
          Type.Object(
            {
              id: Type.String({ format: 'uuid' }),
              emailNormalized: Type.String(),
              purpose: Type.String(),
              createdAt: Type.String({ format: 'date-time' }),
              expiresAt: Type.String({ format: 'date-time' }),
              consumedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
              revokedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
              attemptCount: Type.Integer({ minimum: 0 }),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'PlatformAccountEmailsResponse' },
);

export const PlatformAccountPaymentsResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        entitlement: Type.Union([
          Type.Object(
            {
              status: Type.String(),
              source: Type.String(),
              accessUntil: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
              cancelAtPeriodEnd: Type.Boolean(),
              activatedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
              cancellationRequestedAt: Type.Union([
                Type.String({ format: 'date-time' }),
                Type.Null(),
              ]),
              expiredAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
              version: Type.Integer({ minimum: 0 }),
              updatedAt: Type.String({ format: 'date-time' }),
            },
            { additionalProperties: false },
          ),
          Type.Null(),
        ]),
        stripeCustomer: Type.Union([
          Type.Object(
            {
              linked: Type.Literal(true),
              billingReference: Type.String({ format: 'uuid' }),
              createdAt: Type.String({ format: 'date-time' }),
              updatedAt: Type.String({ format: 'date-time' }),
            },
            { additionalProperties: false },
          ),
          Type.Object(
            {
              linked: Type.Literal(false),
            },
            { additionalProperties: false },
          ),
        ]),
        checkoutAttempts: Type.Array(
          Type.Object(
            {
              id: Type.String({ format: 'uuid' }),
              status: Type.String(),
              hasStripeSession: Type.Boolean(),
              createdAt: Type.String({ format: 'date-time' }),
              expiresAt: Type.String({ format: 'date-time' }),
              completedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'PlatformAccountPaymentsResponse' },
);

export const PlatformOperatorsResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        operators: Type.Array(
          Type.Object(
            {
              accountId: Type.String({ format: 'uuid' }),
              role: PlatformOperatorRoleSchema,
              grantedAt: Type.String({ format: 'date-time' }),
              grantedByAccountId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'PlatformOperatorsResponse' },
);

export const PlatformOperatorGrantBodySchema = Type.Object(
  {
    accountId: Type.String({ format: 'uuid' }),
    role: PlatformOperatorRoleSchema,
  },
  { additionalProperties: false, $id: 'PlatformOperatorGrantBody' },
);

export const PlatformOperatorActionResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        accountId: Type.String({ format: 'uuid' }),
        role: PlatformOperatorRoleSchema,
        active: Type.Boolean(),
        changed: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'PlatformOperatorActionResponse' },
);

export type PlatformSessionResponse = Static<typeof PlatformSessionResponseSchema>;
export type PlatformStatusResponse = Static<typeof PlatformStatusResponseSchema>;
export type PlatformAccountsResponse = Static<typeof PlatformAccountsResponseSchema>;
export type PlatformAccountActionResponse = Static<typeof PlatformAccountActionResponseSchema>;
export type PlatformMembershipsResponse = Static<typeof PlatformMembershipsResponseSchema>;
export type PlatformMembershipActionResponse = Static<
  typeof PlatformMembershipActionResponseSchema
>;
export type PlatformSubmissionsResponse = Static<typeof PlatformSubmissionsResponseSchema>;
export type PlatformSubmissionDetailResponse = Static<
  typeof PlatformSubmissionDetailResponseSchema
>;
export type PlatformSubmissionActionResponse = Static<
  typeof PlatformSubmissionActionResponseSchema
>;
export type PlatformDiscussionsResponse = Static<typeof PlatformDiscussionsResponseSchema>;
export type PlatformDiscussionActionResponse = Static<
  typeof PlatformDiscussionActionResponseSchema
>;

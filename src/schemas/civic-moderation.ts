import { Type, type Static } from '@sinclair/typebox';
import {
  CivicContestationReasonKeySchema,
  CivicContestationStatusSchema,
} from './civic-mandate.js';
import { CivicVerificationOutcomeSchema } from './civic-verification.js';
import { SignalHideReasonSchema } from './signal-moderation.js';
import { DomainErrorResponseSchema } from './error.js';

export const PlatformCivicContentIdParamsSchema = Type.Object(
  {
    contentId: Type.String({ format: 'uuid' }),
  },
  { additionalProperties: false, $id: 'PlatformCivicContentIdParams' },
);

export const PlatformCivicContentHideBodySchema = Type.Object(
  {
    reason: SignalHideReasonSchema,
  },
  { additionalProperties: false, $id: 'PlatformCivicContentHideBody' },
);

export const PlatformCivicContentActionResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        contentId: Type.String({ format: 'uuid' }),
        hidden: Type.Boolean(),
        hiddenAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
        hiddenReason: Type.Union([Type.String(), Type.Null()]),
        changed: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'PlatformCivicContentActionResponse' },
);

export const PlatformCivicContestationIdParamsSchema = Type.Object(
  {
    contestationId: Type.String({ format: 'uuid' }),
  },
  { additionalProperties: false, $id: 'PlatformCivicContestationIdParams' },
);

export const PlatformCivicContestationResolveBodySchema = Type.Object(
  {
    status: Type.Union([Type.Literal('upheld'), Type.Literal('rejected')]),
    reviewNote: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
  },
  { additionalProperties: false, $id: 'PlatformCivicContestationResolveBody' },
);

export const PlatformCivicContestationSchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    processId: Type.String({ format: 'uuid' }),
    reasonKey: CivicContestationReasonKeySchema,
    elaboration: Type.Union([Type.String(), Type.Null()]),
    status: CivicContestationStatusSchema,
    filedAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false, $id: 'PlatformCivicContestation' },
);

export const PlatformCivicContestationsQueueResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        contestations: Type.Array(PlatformCivicContestationSchema, { maxItems: 100 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'PlatformCivicContestationsQueueResponse' },
);

export const PlatformCivicContestationResolvedResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        contestationId: Type.String({ format: 'uuid' }),
        status: CivicContestationStatusSchema,
        reviewedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
        changed: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'PlatformCivicContestationResolvedResponse' },
);

export const PlatformCivicVerificationDisputeProcessIdParamsSchema = Type.Object(
  {
    processId: Type.String({ format: 'uuid' }),
  },
  { additionalProperties: false, $id: 'PlatformCivicVerificationDisputeProcessIdParams' },
);

export const PlatformCivicVerificationDisputeResolveBodySchema = Type.Object(
  {
    outcome: CivicVerificationOutcomeSchema,
    reviewNote: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
  },
  { additionalProperties: false, $id: 'PlatformCivicVerificationDisputeResolveBody' },
);

export const PlatformCivicVerificationDisputeSchema = Type.Object(
  {
    processId: Type.String({ format: 'uuid' }),
    verificationOpenedAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false, $id: 'PlatformCivicVerificationDispute' },
);

export const PlatformCivicVerificationDisputesQueueResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        disputes: Type.Array(PlatformCivicVerificationDisputeSchema, { maxItems: 100 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'PlatformCivicVerificationDisputesQueueResponse' },
);

export const PlatformCivicVerificationDisputeResolvedResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        processId: Type.String({ format: 'uuid' }),
        outcome: CivicVerificationOutcomeSchema,
        resolvedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
        changed: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'PlatformCivicVerificationDisputeResolvedResponse' },
);

export const PlatformCivicModerationRouteResponses = {
  hideContent: {
    200: PlatformCivicContentActionResponseSchema,
    404: DomainErrorResponseSchema,
  },
  contestationsQueue: {
    200: PlatformCivicContestationsQueueResponseSchema,
    404: DomainErrorResponseSchema,
  },
  resolveContestation: {
    200: PlatformCivicContestationResolvedResponseSchema,
    404: DomainErrorResponseSchema,
  },
  verificationDisputesQueue: {
    200: PlatformCivicVerificationDisputesQueueResponseSchema,
    404: DomainErrorResponseSchema,
  },
  resolveVerificationDispute: {
    200: PlatformCivicVerificationDisputeResolvedResponseSchema,
    404: DomainErrorResponseSchema,
  },
} as const;

export type PlatformCivicContentHideBody = Static<typeof PlatformCivicContentHideBodySchema>;
export type PlatformCivicContestationResolveBody = Static<
  typeof PlatformCivicContestationResolveBodySchema
>;
export type PlatformCivicVerificationDisputeResolveBody = Static<
  typeof PlatformCivicVerificationDisputeResolveBodySchema
>;

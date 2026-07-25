import { Type, type Static } from '@sinclair/typebox';
import { DomainErrorResponseSchema } from '../schemas/error.js';

export const MembershipStatusSchema = Type.Union([
  Type.Literal('inactive'),
  Type.Literal('active'),
  Type.Literal('cancelling'),
  Type.Literal('expired'),
  Type.Literal('paid_pending_binding'),
]);

export const CivicAccessLevelSchema = Type.Union([
  Type.Literal('visitor'),
  Type.Literal('read_only'),
  Type.Literal('participant'),
]);

export const LocalParticipationEligibilitySchema = Type.Union([
  Type.Literal('eligible'),
  Type.Literal('not_verified'),
  Type.Literal('expired'),
  Type.Literal('mismatched_community'),
  Type.Literal('unavailable'),
]);

export const AccountMembershipResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        membership: Type.Object(
          {
            status: MembershipStatusSchema,
            accessUntil: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
            cancelAtPeriodEnd: Type.Boolean(),
          },
          { additionalProperties: false },
        ),
        access: Type.Object(
          {
            level: CivicAccessLevelSchema,
            canParticipate: Type.Boolean(),
            localEligibility: LocalParticipationEligibilitySchema,
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'AccountMembershipResponse' },
);

export const MembershipRouteResponses = {
  accountMembership: {
    200: AccountMembershipResponseSchema,
    400: DomainErrorResponseSchema,
    401: DomainErrorResponseSchema,
    403: DomainErrorResponseSchema,
    429: DomainErrorResponseSchema,
  },
} as const;

export type AccountMembershipResponse = Static<typeof AccountMembershipResponseSchema>;

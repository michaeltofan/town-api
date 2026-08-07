import { Type, type Static } from '@sinclair/typebox';
import { DomainErrorResponseSchema } from './error.js';

export const CivicMandateWinnerSchema = Type.Object(
  {
    proposalId: Type.String({ format: 'uuid' }),
    authorDisplayName: Type.String({ minLength: 1 }),
    title: Type.String({ minLength: 1, maxLength: 160 }),
    body: Type.String({ minLength: 1, maxLength: 2000 }),
    voteCount: Type.Integer({ minimum: 0 }),
    targetInstitution: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    objective: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    indicativeDeadline: Type.Union([Type.String({ format: 'date' }), Type.Null()]),
  },
  { additionalProperties: false, $id: 'CivicMandateWinner' },
);

export const CivicMinorityPositionSchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    authorDisplayName: Type.String({ minLength: 1 }),
    proposalId: Type.String({ format: 'uuid' }),
    text: Type.String({ minLength: 1 }),
    createdAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false, $id: 'CivicMinorityPosition' },
);

export const CivicContestationReasonKeySchema = Type.Union(
  [
    Type.Literal('eligibility_error'),
    Type.Literal('ballot_tampering_suspected'),
    Type.Literal('count_discrepancy'),
  ],
  { $id: 'CivicContestationReasonKey' },
);

export const CivicContestationStatusSchema = Type.Union(
  [Type.Literal('pending'), Type.Literal('upheld'), Type.Literal('rejected')],
  { $id: 'CivicContestationStatus' },
);

export const CivicMyContestationSchema = Type.Object(
  {
    reasonKey: CivicContestationReasonKeySchema,
    status: CivicContestationStatusSchema,
    filedAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false, $id: 'CivicMyContestation' },
);

export const CivicMandateResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        processId: Type.String({ format: 'uuid' }),
        currentStage: Type.Union([
          Type.Literal('deliberation'),
          Type.Literal('voting'),
          Type.Literal('mandate'),
          Type.Literal('action'),
          Type.Literal('verification'),
          Type.Literal('archived'),
        ]),
        decided: Type.Boolean(),
        contested: Type.Boolean(),
        quorumFailed: Type.Boolean(),
        winner: Type.Union([CivicMandateWinnerSchema, Type.Null()]),
        totalVotes: Type.Integer({ minimum: 0 }),
        votingClosesAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
        decidedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
        minorityPositions: Type.Array(CivicMinorityPositionSchema, { maxItems: 200 }),
        contestationWindowClosesAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
        contestationPending: Type.Boolean(),
        myContestation: Type.Union([CivicMyContestationSchema, Type.Null()]),
        canContest: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'CivicMandateResponse' },
);

export const CivicMandateContestBodySchema = Type.Object(
  {
    reasonKey: CivicContestationReasonKeySchema,
    elaboration: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
  },
  { additionalProperties: false, $id: 'CivicMandateContestBody' },
);

export const CivicMandateContestCreatedResponseSchema = Type.Object(
  {
    data: CivicMyContestationSchema,
  },
  { additionalProperties: false, $id: 'CivicMandateContestCreatedResponse' },
);

export const CivicMandateRouteResponses = {
  read: {
    200: CivicMandateResponseSchema,
    400: DomainErrorResponseSchema,
    404: DomainErrorResponseSchema,
  },
  contest: {
    201: CivicMandateContestCreatedResponseSchema,
    400: DomainErrorResponseSchema,
    401: DomainErrorResponseSchema,
    403: DomainErrorResponseSchema,
    404: DomainErrorResponseSchema,
    409: DomainErrorResponseSchema,
  },
} as const;

export type CivicMandateResponse = Static<typeof CivicMandateResponseSchema>;
export type CivicMandateContestBody = Static<typeof CivicMandateContestBodySchema>;

import { Type, type Static } from '@sinclair/typebox';
import { DomainErrorResponseSchema } from './error.js';

export const CivicMandateWinnerSchema = Type.Object(
  {
    proposalId: Type.String({ format: 'uuid' }),
    authorDisplayName: Type.String({ minLength: 1 }),
    title: Type.String({ minLength: 1, maxLength: 160 }),
    body: Type.String({ minLength: 1, maxLength: 2000 }),
    voteCount: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false, $id: 'CivicMandateWinner' },
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
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'CivicMandateResponse' },
);

export const CivicMandateRouteResponses = {
  read: {
    200: CivicMandateResponseSchema,
    400: DomainErrorResponseSchema,
    404: DomainErrorResponseSchema,
  },
} as const;

export type CivicMandateResponse = Static<typeof CivicMandateResponseSchema>;

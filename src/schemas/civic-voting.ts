import { Type, type Static } from '@sinclair/typebox';
import { DomainErrorResponseSchema } from './error.js';

export const CivicVoteBodySchema = Type.Object(
  {
    proposalId: Type.String({ format: 'uuid' }),
  },
  { additionalProperties: false, $id: 'CivicVoteBody' },
);

export const CivicVoteOptionSchema = Type.Object(
  {
    proposalId: Type.String({ format: 'uuid' }),
    authorDisplayName: Type.String({ minLength: 1 }),
    title: Type.String({ minLength: 1, maxLength: 160 }),
    body: Type.String({ minLength: 1, maxLength: 2000 }),
    voteCount: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false, $id: 'CivicVoteOption' },
);

export const CivicVotingResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        processId: Type.String({ format: 'uuid' }),
        currentStage: Type.Union([
          Type.Literal('ballot_preparation'),
          Type.Literal('voting'),
          Type.Literal('mandate'),
          Type.Literal('action'),
        ]),
        canVote: Type.Boolean(),
        hasVoted: Type.Boolean(),
        myChoice: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
        totalVotes: Type.Integer({ minimum: 0 }),
        options: Type.Array(CivicVoteOptionSchema, { maxItems: 100 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'CivicVotingResponse' },
);

export const CivicVoteCastResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        proposalId: Type.String({ format: 'uuid' }),
        castAt: Type.String({ format: 'date-time' }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'CivicVoteCastResponse' },
);

export const CivicVotingRouteResponses = {
  read: {
    200: CivicVotingResponseSchema,
    400: DomainErrorResponseSchema,
    404: DomainErrorResponseSchema,
  },
  create: {
    201: CivicVoteCastResponseSchema,
    400: DomainErrorResponseSchema,
    401: DomainErrorResponseSchema,
    403: DomainErrorResponseSchema,
    404: DomainErrorResponseSchema,
    409: DomainErrorResponseSchema,
  },
} as const;

export type CivicVoteBody = Static<typeof CivicVoteBodySchema>;

import { Type, type Static } from '@sinclair/typebox';
import { DomainErrorResponseSchema } from './error.js';

export const CivicProposalBodySchema = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 160 }),
    body: Type.String({ minLength: 1, maxLength: 2000 }),
  },
  { additionalProperties: false, $id: 'CivicProposalBody' },
);

export const CivicProposalSchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    authorDisplayName: Type.String({ minLength: 1 }),
    title: Type.String({ minLength: 1, maxLength: 160 }),
    body: Type.String({ minLength: 1, maxLength: 2000 }),
    createdAt: Type.String({ format: 'date-time' }),
    isMine: Type.Boolean(),
  },
  { additionalProperties: false, $id: 'CivicProposal' },
);

export const CivicProposalListResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        processId: Type.String({ format: 'uuid' }),
        currentStage: Type.Union([
          Type.Literal('confirmation'),
          Type.Literal('proposals'),
          Type.Literal('deliberation'),
          Type.Literal('ballot_preparation'),
          Type.Literal('voting'),
          Type.Literal('mandate'),
        ]),
        canPropose: Type.Boolean(),
        proposals: Type.Array(CivicProposalSchema, { maxItems: 100 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'CivicProposalListResponse' },
);

export const CivicProposalCreatedResponseSchema = Type.Object(
  {
    data: CivicProposalSchema,
  },
  { additionalProperties: false, $id: 'CivicProposalCreatedResponse' },
);

export const CivicProposalRouteResponses = {
  read: {
    200: CivicProposalListResponseSchema,
    400: DomainErrorResponseSchema,
    404: DomainErrorResponseSchema,
  },
  create: {
    201: CivicProposalCreatedResponseSchema,
    400: DomainErrorResponseSchema,
    401: DomainErrorResponseSchema,
    403: DomainErrorResponseSchema,
    404: DomainErrorResponseSchema,
    409: DomainErrorResponseSchema,
  },
} as const;

export type CivicProposalBody = Static<typeof CivicProposalBodySchema>;

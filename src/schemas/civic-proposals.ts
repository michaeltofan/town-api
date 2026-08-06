import { Type, type Static } from '@sinclair/typebox';
import { DomainErrorResponseSchema } from './error.js';

const OptionalTextField = (maxLength: number) =>
  Type.Optional(Type.String({ minLength: 1, maxLength }));

export const CivicProposalBodySchema = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 160 }),
    body: Type.String({ minLength: 1, maxLength: 2000 }),
    expectedOutcome: Type.String({ minLength: 1, maxLength: 500 }),
    targetInstitution: OptionalTextField(200),
    estimatedResources: OptionalTextField(500),
    indicativeDeadline: Type.Optional(Type.String({ format: 'date' })),
  },
  { additionalProperties: false, $id: 'CivicProposalBody' },
);

export const CivicProposalLifecycleStateSchema = Type.Union([
  Type.Literal('published'),
  Type.Literal('revised'),
  Type.Literal('withdrawn'),
]);

export const CivicProposalSchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    authorDisplayName: Type.String({ minLength: 1 }),
    title: Type.String({ minLength: 1, maxLength: 160 }),
    body: Type.String({ minLength: 1, maxLength: 2000 }),
    targetInstitution: Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()]),
    expectedOutcome: Type.Union([Type.String({ minLength: 1, maxLength: 500 }), Type.Null()]),
    estimatedResources: Type.Union([Type.String({ minLength: 1, maxLength: 500 }), Type.Null()]),
    indicativeDeadline: Type.Union([Type.String({ format: 'date' }), Type.Null()]),
    lifecycleState: CivicProposalLifecycleStateSchema,
    revisedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    withdrawnAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    createdAt: Type.String({ format: 'date-time' }),
    isMine: Type.Boolean(),
    canRevise: Type.Boolean(),
    canWithdraw: Type.Boolean(),
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
          Type.Literal('action'),
          Type.Literal('verification'),
          Type.Literal('archived'),
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
  revise: {
    200: CivicProposalCreatedResponseSchema,
    400: DomainErrorResponseSchema,
    401: DomainErrorResponseSchema,
    403: DomainErrorResponseSchema,
    404: DomainErrorResponseSchema,
    409: DomainErrorResponseSchema,
  },
  withdraw: {
    200: CivicProposalCreatedResponseSchema,
    401: DomainErrorResponseSchema,
    403: DomainErrorResponseSchema,
    404: DomainErrorResponseSchema,
    409: DomainErrorResponseSchema,
  },
} as const;

export type CivicProposalBody = Static<typeof CivicProposalBodySchema>;

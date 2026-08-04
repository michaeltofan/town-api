import { Type, type Static } from '@sinclair/typebox';
import { DomainErrorResponseSchema } from './error.js';

export const SignalProposalIdParamsSchema = Type.Object(
  {
    signalId: Type.String({ format: 'uuid' }),
    proposalId: Type.String({ format: 'uuid' }),
  },
  { additionalProperties: false, $id: 'SignalProposalIdParams' },
);

export const CivicDeliberationIntentSchema = Type.Union(
  [Type.Literal('observation'), Type.Literal('proposal'), Type.Literal('next_step')],
  { $id: 'CivicDeliberationIntent' },
);

export const CivicDeliberationContributionBodySchema = Type.Object(
  {
    intent: CivicDeliberationIntentSchema,
    text: Type.String({ minLength: 12, maxLength: 480 }),
  },
  { additionalProperties: false, $id: 'CivicDeliberationContributionBody' },
);

export const CivicDeliberationContributionSchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    authorDisplayName: Type.String({ minLength: 1 }),
    intent: CivicDeliberationIntentSchema,
    text: Type.String({ minLength: 1 }),
    createdAt: Type.String({ format: 'date-time' }),
    isMine: Type.Boolean(),
  },
  { additionalProperties: false, $id: 'CivicDeliberationContribution' },
);

export const CivicDeliberationProposalSchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    authorDisplayName: Type.String({ minLength: 1 }),
    title: Type.String({ minLength: 1, maxLength: 160 }),
    body: Type.String({ minLength: 1, maxLength: 2000 }),
    createdAt: Type.String({ format: 'date-time' }),
    isMine: Type.Boolean(),
    contributions: Type.Array(CivicDeliberationContributionSchema, { maxItems: 200 }),
  },
  { additionalProperties: false, $id: 'CivicDeliberationProposal' },
);

export const CivicDeliberationResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        processId: Type.String({ format: 'uuid' }),
        currentStage: Type.Union([
          Type.Literal('proposals'),
          Type.Literal('deliberation'),
          Type.Literal('ballot_preparation'),
          Type.Literal('voting'),
          Type.Literal('mandate'),
          Type.Literal('action'),
          Type.Literal('verification'),
          Type.Literal('archived'),
        ]),
        canContribute: Type.Boolean(),
        proposals: Type.Array(CivicDeliberationProposalSchema, { maxItems: 100 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'CivicDeliberationResponse' },
);

export const CivicDeliberationContributionCreatedResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        proposalId: Type.String({ format: 'uuid' }),
        contribution: CivicDeliberationContributionSchema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'CivicDeliberationContributionCreatedResponse' },
);

export const CivicDeliberationRouteResponses = {
  read: {
    200: CivicDeliberationResponseSchema,
    400: DomainErrorResponseSchema,
    404: DomainErrorResponseSchema,
  },
  create: {
    201: CivicDeliberationContributionCreatedResponseSchema,
    400: DomainErrorResponseSchema,
    401: DomainErrorResponseSchema,
    403: DomainErrorResponseSchema,
    404: DomainErrorResponseSchema,
    409: DomainErrorResponseSchema,
  },
} as const;

export type CivicDeliberationContributionBody = Static<
  typeof CivicDeliberationContributionBodySchema
>;

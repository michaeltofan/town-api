import { Type, type Static } from '@sinclair/typebox';
import { DomainErrorResponseSchema } from './error.js';
import { SignalIdParamsSchema } from './signals.js';

export { SignalIdParamsSchema };

export const DiscussionContributionIntentSchema = Type.Union(
  [Type.Literal('observation'), Type.Literal('proposal'), Type.Literal('next_step')],
  { $id: 'DiscussionContributionIntent' },
);

export const DiscussionContributionBodySchema = Type.Object(
  {
    text: Type.String({ minLength: 1, maxLength: 480 }),
    intent: DiscussionContributionIntentSchema,
  },
  { additionalProperties: false, $id: 'DiscussionContributionBody' },
);

export const DiscussionContributionSchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    authorDisplayName: Type.String(),
    text: Type.String(),
    intent: DiscussionContributionIntentSchema,
    createdAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false, $id: 'DiscussionContribution' },
);

export const DiscussionSessionSchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    signalId: Type.String({ format: 'uuid' }),
    createdAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false, $id: 'DiscussionSession' },
);

export const DiscussionSessionResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        session: DiscussionSessionSchema,
        contributions: Type.Array(DiscussionContributionSchema),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'DiscussionSessionResponse' },
);

export const DiscussionSessionRouteResponses = {
  read: {
    200: DiscussionSessionResponseSchema,
    400: DomainErrorResponseSchema,
    401: DomainErrorResponseSchema,
    403: DomainErrorResponseSchema,
    404: DomainErrorResponseSchema,
  },
  contribute: {
    201: DiscussionSessionResponseSchema,
    400: DomainErrorResponseSchema,
    401: DomainErrorResponseSchema,
    403: DomainErrorResponseSchema,
    404: DomainErrorResponseSchema,
  },
} as const;

export type DiscussionContributionBody = Static<typeof DiscussionContributionBodySchema>;
export type DiscussionSessionResponse = Static<typeof DiscussionSessionResponseSchema>;

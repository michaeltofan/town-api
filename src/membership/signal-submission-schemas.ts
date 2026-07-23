import { Type, type Static } from '@sinclair/typebox';
import { DomainErrorResponseSchema } from '../schemas/error.js';
import { CommunitySlugParamsSchema } from '../schemas/communities.js';

export { CommunitySlugParamsSchema };

export const SignalSubmissionBodySchema = Type.Object(
  {
    headline: Type.String({ minLength: 1, maxLength: 400 }),
    body: Type.String({ minLength: 1, maxLength: 4000 }),
  },
  { additionalProperties: false, $id: 'SignalSubmissionBody' },
);

export const SignalSubmissionCreatedResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        id: Type.String({ format: 'uuid' }),
        status: Type.Literal('pending_review'),
        community: Type.Object(
          {
            slug: Type.String(),
          },
          { additionalProperties: false },
        ),
        createdAt: Type.String({ format: 'date-time' }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'SignalSubmissionCreatedResponse' },
);

export const SignalSubmissionRouteResponses = {
  create: {
    201: SignalSubmissionCreatedResponseSchema,
    400: DomainErrorResponseSchema,
    401: DomainErrorResponseSchema,
    403: DomainErrorResponseSchema,
    404: DomainErrorResponseSchema,
    429: DomainErrorResponseSchema,
  },
} as const;

export type SignalSubmissionBody = Static<typeof SignalSubmissionBodySchema>;
export type SignalSubmissionCreatedResponse = Static<typeof SignalSubmissionCreatedResponseSchema>;

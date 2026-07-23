import { Type, type Static } from '@sinclair/typebox';
import { DomainErrorResponseSchema } from '../schemas/error.js';

export const LocalEligibilityBindBodySchema = Type.Object(
  {
    community: Type.String({ minLength: 1, maxLength: 100 }),
  },
  { additionalProperties: false, $id: 'LocalEligibilityBindBody' },
);

export const LocalEligibilityBindResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        community: Type.Object(
          {
            slug: Type.String(),
            displayName: Type.String(),
          },
          { additionalProperties: false },
        ),
        verifiedAt: Type.String({ format: 'date-time' }),
        localEligibility: Type.Literal('eligible'),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'LocalEligibilityBindResponse' },
);

export const LocalEligibilityRouteResponses = {
  bind: {
    200: LocalEligibilityBindResponseSchema,
    400: DomainErrorResponseSchema,
    401: DomainErrorResponseSchema,
    404: DomainErrorResponseSchema,
    409: DomainErrorResponseSchema,
    429: DomainErrorResponseSchema,
    500: DomainErrorResponseSchema,
  },
} as const;

export type LocalEligibilityBindBody = Static<typeof LocalEligibilityBindBodySchema>;
export type LocalEligibilityBindResponse = Static<typeof LocalEligibilityBindResponseSchema>;

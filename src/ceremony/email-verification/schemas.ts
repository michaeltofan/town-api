import { Type, type Static } from '@sinclair/typebox';
import { DomainErrorResponseSchema } from '../../schemas/signals.js';
import { ErrorResponseSchema } from '../../schemas/error.js';

export const EmailVerificationRequestBodySchema = Type.Object(
  {
    email: Type.String({ minLength: 3, maxLength: 320 }),
    locale: Type.Optional(Type.String({ minLength: 2, maxLength: 16 })),
  },
  { additionalProperties: false },
);

export const EmailVerificationCompleteBodySchema = Type.Object(
  {
    verificationId: Type.String({
      pattern:
        '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$',
    }),
    code: Type.String({ pattern: '^[0-9]{6}$' }),
  },
  { additionalProperties: false },
);

export const EmailVerificationRequestAcceptedSchema = Type.Object(
  {
    data: Type.Object(
      {
        status: Type.Literal('VERIFICATION_REQUEST_ACCEPTED'),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const EmailVerificationCompleteSuccessSchema = Type.Object(
  {
    data: Type.Object(
      {
        status: Type.Literal('EMAIL_VERIFIED'),
        setupGrant: Type.String({ minLength: 1 }),
        setupGrantExpiresAt: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const EmailVerificationRouteResponses = {
  request: {
    202: EmailVerificationRequestAcceptedSchema,
    400: ErrorResponseSchema,
    404: ErrorResponseSchema,
  },
  complete: {
    200: EmailVerificationCompleteSuccessSchema,
    400: DomainErrorResponseSchema,
    404: ErrorResponseSchema,
  },
} as const;

export type EmailVerificationRequestBody = Static<typeof EmailVerificationRequestBodySchema>;
export type EmailVerificationCompleteBody = Static<typeof EmailVerificationCompleteBodySchema>;

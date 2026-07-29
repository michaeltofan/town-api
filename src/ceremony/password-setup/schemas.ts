import { Type, type Static } from '@sinclair/typebox';
import { DomainErrorResponseSchema } from '../../schemas/error.js';

export const PasswordSetupBodySchema = Type.Object(
  {
    password: Type.String({ minLength: 1, maxLength: 512 }),
  },
  { additionalProperties: false },
);

export const PasswordSetupSuccessSchema = Type.Object(
  {
    data: Type.Object(
      {
        status: Type.Literal('PASSWORD_SET'),
        setupGrant: Type.String({ minLength: 1 }),
        setupGrantExpiresAt: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const PasswordSetupRouteResponses = {
  200: PasswordSetupSuccessSchema,
  400: DomainErrorResponseSchema,
  404: DomainErrorResponseSchema,
} as const;

export type PasswordSetupBody = Static<typeof PasswordSetupBodySchema>;

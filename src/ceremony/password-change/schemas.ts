import { Type, type Static } from '@sinclair/typebox';
import { DomainErrorResponseSchema } from '../../schemas/error.js';

export const PasswordChangeBodySchema = Type.Object(
  {
    currentPassword: Type.String({ minLength: 1, maxLength: 256 }),
    newPassword: Type.String({ minLength: 1, maxLength: 512 }),
  },
  { additionalProperties: false },
);

export const PasswordChangeSuccessSchema = Type.Object(
  {
    data: Type.Object(
      {
        status: Type.Literal('PASSWORD_CHANGED'),
        sessionToken: Type.Optional(Type.String({ minLength: 1 })),
        sessionExpiresAt: Type.Optional(Type.String({ minLength: 1 })),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const PasswordChangeRouteResponses = {
  200: PasswordChangeSuccessSchema,
  400: DomainErrorResponseSchema,
  401: DomainErrorResponseSchema,
  404: DomainErrorResponseSchema,
  429: DomainErrorResponseSchema,
} as const;

export type PasswordChangeBody = Static<typeof PasswordChangeBodySchema>;

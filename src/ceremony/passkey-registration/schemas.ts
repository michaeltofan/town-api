import { Type, type Static } from '@sinclair/typebox';
import { DomainErrorResponseSchema } from '../../schemas/error.js';

const UuidSchema = Type.String({
  pattern:
    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$',
});

export const PasskeyRegistrationOptionsBodySchema = Type.Object(
  {},
  { additionalProperties: false },
);

export const PasskeyRegistrationVerifyBodySchema = Type.Object(
  {
    registrationCeremonyId: UuidSchema,
    response: Type.Object(
      {
        id: Type.String({ minLength: 1, maxLength: 1024 }),
        rawId: Type.String({ minLength: 1, maxLength: 1024 }),
        type: Type.Literal('public-key'),
        response: Type.Object(
          {
            clientDataJSON: Type.String({ minLength: 1 }),
            attestationObject: Type.String({ minLength: 1 }),
            transports: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 64 }))),
          },
          { additionalProperties: true },
        ),
        clientExtensionResults: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        authenticatorAttachment: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const PasskeyRegistrationOptionsSuccessSchema = Type.Object(
  {
    data: Type.Object(
      {
        registrationCeremonyId: UuidSchema,
        options: Type.Object({}, { additionalProperties: true }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const PasskeyRegistrationVerifySuccessSchema = Type.Object(
  {
    data: Type.Object(
      {
        status: Type.Literal('ACCOUNT_READY'),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const PasskeyRegistrationRouteResponses = {
  options: {
    200: PasskeyRegistrationOptionsSuccessSchema,
    400: DomainErrorResponseSchema,
    404: DomainErrorResponseSchema,
  },
  verify: {
    200: PasskeyRegistrationVerifySuccessSchema,
    400: DomainErrorResponseSchema,
    404: DomainErrorResponseSchema,
  },
} as const;

export type PasskeyRegistrationOptionsBody = Static<typeof PasskeyRegistrationOptionsBodySchema>;
export type PasskeyRegistrationVerifyBody = Static<typeof PasskeyRegistrationVerifyBodySchema>;

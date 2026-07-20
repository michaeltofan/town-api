import { Type, type Static } from '@sinclair/typebox';
import { DomainErrorResponseSchema } from '../../schemas/error.js';

const UuidSchema = Type.String({
  pattern:
    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$',
});

export const AccountRecoveryRequestBodySchema = Type.Object(
  {
    email: Type.String({ minLength: 3, maxLength: 320 }),
    locale: Type.Optional(Type.String({ minLength: 2, maxLength: 16 })),
  },
  { additionalProperties: false },
);

export const AccountRecoveryVerifyEmailBodySchema = Type.Object(
  {
    recoveryVerificationId: UuidSchema,
    code: Type.String({ pattern: '^[0-9]{6}$' }),
  },
  { additionalProperties: false },
);

export const AccountRecoveryPasskeyOptionsBodySchema = Type.Object(
  {},
  { additionalProperties: false },
);

export const AccountRecoveryPasskeyVerifyBodySchema = Type.Object(
  {
    recoveryCeremonyId: UuidSchema,
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

export const AccountRecoveryRequestAcceptedSchema = Type.Object(
  {
    data: Type.Object(
      {
        status: Type.Literal('RECOVERY_REQUEST_ACCEPTED'),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const AccountRecoveryVerifyEmailSuccessSchema = Type.Object(
  {
    data: Type.Object(
      {
        status: Type.Literal('RECOVERY_EMAIL_VERIFIED'),
        recoveryGrant: Type.String({ minLength: 1 }),
        recoveryGrantExpiresAt: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const AccountRecoveryPasskeyOptionsSuccessSchema = Type.Object(
  {
    data: Type.Object(
      {
        recoveryCeremonyId: UuidSchema,
        options: Type.Object({}, { additionalProperties: true }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const AccountRecoveryPasskeyVerifySuccessSchema = Type.Object(
  {
    data: Type.Object(
      {
        status: Type.Literal('RECOVERY_COMPLETE'),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const AccountRecoveryRouteResponses = {
  request: {
    202: AccountRecoveryRequestAcceptedSchema,
    400: DomainErrorResponseSchema,
    404: DomainErrorResponseSchema,
  },
  verifyEmail: {
    200: AccountRecoveryVerifyEmailSuccessSchema,
    400: DomainErrorResponseSchema,
    404: DomainErrorResponseSchema,
  },
  options: {
    200: AccountRecoveryPasskeyOptionsSuccessSchema,
    400: DomainErrorResponseSchema,
    404: DomainErrorResponseSchema,
  },
  verify: {
    200: AccountRecoveryPasskeyVerifySuccessSchema,
    400: DomainErrorResponseSchema,
    404: DomainErrorResponseSchema,
  },
} as const;

export type AccountRecoveryRequestBody = Static<typeof AccountRecoveryRequestBodySchema>;
export type AccountRecoveryVerifyEmailBody = Static<typeof AccountRecoveryVerifyEmailBodySchema>;
export type AccountRecoveryPasskeyOptionsBody = Static<
  typeof AccountRecoveryPasskeyOptionsBodySchema
>;
export type AccountRecoveryPasskeyVerifyBody = Static<
  typeof AccountRecoveryPasskeyVerifyBodySchema
>;

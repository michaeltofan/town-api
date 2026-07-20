import { Type, type Static } from '@sinclair/typebox';
import { DomainErrorResponseSchema } from '../../schemas/error.js';
import { ANONYMOUS_CLIENT_KEY_MAX_LENGTH, ANONYMOUS_CLIENT_KEY_MIN_LENGTH } from './policy.js';

const UuidSchema = Type.String({
  pattern:
    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$',
});

const ClientTypeSchema = Type.Union([Type.Literal('web'), Type.Literal('mobile')]);

export const PasskeyAuthenticationOptionsBodySchema = Type.Object(
  {
    clientType: ClientTypeSchema,
    anonymousClientKey: Type.String({
      minLength: ANONYMOUS_CLIENT_KEY_MIN_LENGTH,
      maxLength: ANONYMOUS_CLIENT_KEY_MAX_LENGTH,
      pattern: '^[A-Za-z0-9._~-]{16,128}$',
    }),
  },
  { additionalProperties: false },
);

export const PasskeyAuthenticationVerifyBodySchema = Type.Object(
  {
    authenticationCeremonyId: UuidSchema,
    clientType: ClientTypeSchema,
    response: Type.Object(
      {
        id: Type.String({ minLength: 1, maxLength: 1024 }),
        rawId: Type.String({ minLength: 1, maxLength: 1024 }),
        type: Type.Literal('public-key'),
        response: Type.Object(
          {
            clientDataJSON: Type.String({ minLength: 1 }),
            authenticatorData: Type.String({ minLength: 1 }),
            signature: Type.String({ minLength: 1 }),
            userHandle: Type.Optional(Type.String({ minLength: 1 })),
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

export const PasskeyAuthenticationOptionsSuccessSchema = Type.Object(
  {
    data: Type.Object(
      {
        authenticationCeremonyId: UuidSchema,
        options: Type.Object({}, { additionalProperties: true }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const PasskeyAuthenticationVerifyWebSuccessSchema = Type.Object(
  {
    data: Type.Object(
      {
        status: Type.Literal('AUTHENTICATED'),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const PasskeyAuthenticationVerifyMobileSuccessSchema = Type.Object(
  {
    data: Type.Object(
      {
        status: Type.Literal('AUTHENTICATED'),
        sessionToken: Type.String({ minLength: 1 }),
        sessionExpiresAt: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const SessionIntrospectionAuthenticatedSchema = Type.Object(
  {
    data: Type.Object(
      {
        authenticated: Type.Literal(true),
        clientType: ClientTypeSchema,
        sensitiveOperationsFresh: Type.Boolean(),
        idleExpiresAt: Type.String({ minLength: 1 }),
        absoluteExpiresAt: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const SessionIntrospectionUnauthenticatedSchema = Type.Object(
  {
    data: Type.Object(
      {
        authenticated: Type.Literal(false),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const SignedOutSuccessSchema = Type.Object(
  {
    data: Type.Object(
      {
        status: Type.Literal('SIGNED_OUT'),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const PasskeyAuthenticationRouteResponses = {
  options: {
    200: PasskeyAuthenticationOptionsSuccessSchema,
    400: DomainErrorResponseSchema,
    404: DomainErrorResponseSchema,
  },
  verify: {
    200: Type.Union([
      PasskeyAuthenticationVerifyWebSuccessSchema,
      PasskeyAuthenticationVerifyMobileSuccessSchema,
    ]),
    400: DomainErrorResponseSchema,
    404: DomainErrorResponseSchema,
  },
  session: {
    200: Type.Union([
      SessionIntrospectionAuthenticatedSchema,
      SessionIntrospectionUnauthenticatedSchema,
    ]),
    404: DomainErrorResponseSchema,
  },
  rotate: {
    200: Type.Union([
      PasskeyAuthenticationVerifyWebSuccessSchema,
      PasskeyAuthenticationVerifyMobileSuccessSchema,
    ]),
    400: DomainErrorResponseSchema,
    401: DomainErrorResponseSchema,
    404: DomainErrorResponseSchema,
  },
  logout: {
    200: SignedOutSuccessSchema,
    404: DomainErrorResponseSchema,
  },
  logoutAll: {
    200: SignedOutSuccessSchema,
    400: DomainErrorResponseSchema,
    401: DomainErrorResponseSchema,
    404: DomainErrorResponseSchema,
  },
} as const;

export type PasskeyAuthenticationOptionsBody = Static<
  typeof PasskeyAuthenticationOptionsBodySchema
>;
export type PasskeyAuthenticationVerifyBody = Static<typeof PasskeyAuthenticationVerifyBodySchema>;

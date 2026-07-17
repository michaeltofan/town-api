import { Type, type Static } from '@sinclair/typebox';
import { DomainErrorResponseSchema } from '../../schemas/signals.js';
import { ErrorResponseSchema } from '../../schemas/error.js';
import { PASSKEY_LABEL_MAX_CODE_POINTS } from './policy.js';

const UuidSchema = Type.String({
  pattern:
    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$',
});

export const PasskeyIdParamsSchema = Type.Object(
  {
    passkeyId: UuidSchema,
  },
  { additionalProperties: false },
);

const PasskeyDeviceTypeSchema = Type.Union([
  Type.Literal('multiDevice'),
  Type.Literal('singleDevice'),
  Type.Null(),
]);

export const PasskeyInventoryItemSchema = Type.Object(
  {
    id: UuidSchema,
    label: Type.Union([Type.String(), Type.Null()]),
    createdAt: Type.String({ minLength: 1 }),
    lastUsedAt: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    deviceType: PasskeyDeviceTypeSchema,
    backupEligible: Type.Union([Type.Boolean(), Type.Null()]),
    backedUp: Type.Union([Type.Boolean(), Type.Null()]),
    currentSessionCredential: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const PasskeyInventorySuccessSchema = Type.Object(
  {
    data: Type.Object(
      {
        passkeys: Type.Array(PasskeyInventoryItemSchema),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const PasskeyReauthenticationOptionsBodySchema = Type.Object(
  {},
  { additionalProperties: false },
);

export const PasskeyReauthenticationVerifyBodySchema = Type.Object(
  {
    reauthenticationCeremonyId: UuidSchema,
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

export const PasskeyReauthenticationOptionsSuccessSchema = Type.Object(
  {
    data: Type.Object(
      {
        reauthenticationCeremonyId: UuidSchema,
        options: Type.Object({}, { additionalProperties: true }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const FreshAuthConfirmedCoreSchema = Type.Object(
  {
    status: Type.Literal('FRESH_AUTHENTICATION_CONFIRMED'),
    freshUntil: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

const MobileSessionFieldsSchema = {
  sessionToken: Type.String({ minLength: 1 }),
  sessionExpiresAt: Type.String({ minLength: 1 }),
};

export const PasskeyReauthenticationVerifyWebSuccessSchema = Type.Object(
  {
    data: FreshAuthConfirmedCoreSchema,
  },
  { additionalProperties: false },
);

export const PasskeyReauthenticationVerifyMobileSuccessSchema = Type.Object(
  {
    data: Type.Object(
      {
        status: Type.Literal('FRESH_AUTHENTICATION_CONFIRMED'),
        freshUntil: Type.String({ minLength: 1 }),
        ...MobileSessionFieldsSchema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const PasskeyManagementRegistrationOptionsBodySchema = Type.Object(
  {},
  { additionalProperties: false },
);

export const PasskeyManagementRegistrationVerifyBodySchema = Type.Object(
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
    label: Type.Optional(
      Type.Union([Type.String({ maxLength: PASSKEY_LABEL_MAX_CODE_POINTS * 4 }), Type.Null()]),
    ),
  },
  { additionalProperties: false },
);

export const PasskeyManagementRegistrationOptionsSuccessSchema = Type.Object(
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

export const PasskeyAddedSummarySchema = Type.Object(
  {
    id: UuidSchema,
    label: Type.Union([Type.String(), Type.Null()]),
    createdAt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const PasskeyAddedWebSuccessSchema = Type.Object(
  {
    data: Type.Object(
      {
        status: Type.Literal('PASSKEY_ADDED'),
        passkey: PasskeyAddedSummarySchema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const PasskeyAddedMobileSuccessSchema = Type.Object(
  {
    data: Type.Object(
      {
        status: Type.Literal('PASSKEY_ADDED'),
        passkey: PasskeyAddedSummarySchema,
        ...MobileSessionFieldsSchema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const PasskeyRenameBodySchema = Type.Object(
  {
    label: Type.Union([Type.String({ maxLength: PASSKEY_LABEL_MAX_CODE_POINTS * 4 }), Type.Null()]),
  },
  { additionalProperties: false },
);

export const PasskeyRenameSuccessSchema = Type.Object(
  {
    data: Type.Object(
      {
        status: Type.Literal('PASSKEY_UPDATED'),
        passkey: PasskeyInventoryItemSchema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const PasskeyRevokeWebSuccessSchema = Type.Object(
  {
    data: Type.Object(
      {
        status: Type.Literal('PASSKEY_REVOKED'),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const PasskeyRevokeMobileSuccessSchema = Type.Object(
  {
    data: Type.Object(
      {
        status: Type.Literal('PASSKEY_REVOKED'),
        ...MobileSessionFieldsSchema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const DualModeRegistrationVerifySuccessSchema = Type.Union([
  Type.Object(
    {
      data: Type.Object(
        {
          status: Type.Literal('ACCOUNT_READY'),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
  PasskeyAddedWebSuccessSchema,
  PasskeyAddedMobileSuccessSchema,
]);

export const PasskeyManagementRouteResponses = {
  inventory: {
    200: PasskeyInventorySuccessSchema,
    401: DomainErrorResponseSchema,
    404: ErrorResponseSchema,
    429: DomainErrorResponseSchema,
  },
  reauthOptions: {
    200: PasskeyReauthenticationOptionsSuccessSchema,
    400: DomainErrorResponseSchema,
    401: DomainErrorResponseSchema,
    404: ErrorResponseSchema,
    429: DomainErrorResponseSchema,
  },
  reauthVerify: {
    200: Type.Union([
      PasskeyReauthenticationVerifyWebSuccessSchema,
      PasskeyReauthenticationVerifyMobileSuccessSchema,
    ]),
    400: DomainErrorResponseSchema,
    401: DomainErrorResponseSchema,
    404: ErrorResponseSchema,
    429: DomainErrorResponseSchema,
  },
  dualRegistrationOptions: {
    200: PasskeyManagementRegistrationOptionsSuccessSchema,
    400: DomainErrorResponseSchema,
    401: DomainErrorResponseSchema,
    403: DomainErrorResponseSchema,
    404: ErrorResponseSchema,
    429: DomainErrorResponseSchema,
  },
  dualRegistrationVerify: {
    200: DualModeRegistrationVerifySuccessSchema,
    400: DomainErrorResponseSchema,
    401: DomainErrorResponseSchema,
    403: DomainErrorResponseSchema,
    404: ErrorResponseSchema,
    429: DomainErrorResponseSchema,
  },
  rename: {
    200: PasskeyRenameSuccessSchema,
    400: DomainErrorResponseSchema,
    401: DomainErrorResponseSchema,
    404: DomainErrorResponseSchema,
    429: DomainErrorResponseSchema,
  },
  revoke: {
    200: Type.Union([PasskeyRevokeWebSuccessSchema, PasskeyRevokeMobileSuccessSchema]),
    400: DomainErrorResponseSchema,
    401: DomainErrorResponseSchema,
    403: DomainErrorResponseSchema,
    404: DomainErrorResponseSchema,
    409: DomainErrorResponseSchema,
    429: DomainErrorResponseSchema,
  },
} as const;

export type PasskeyRenameBody = Static<typeof PasskeyRenameBodySchema>;
export type PasskeyReauthenticationVerifyBody = Static<
  typeof PasskeyReauthenticationVerifyBodySchema
>;
export type PasskeyManagementRegistrationVerifyBody = Static<
  typeof PasskeyManagementRegistrationVerifyBodySchema
>;

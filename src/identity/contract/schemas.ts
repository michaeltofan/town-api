import { Type } from '@sinclair/typebox';

/**
 * Architecture-only TypeBox schemas for future account identity endpoints.
 * These are not registered as live Fastify routes in this foundation slice.
 */

export const IdentityErrorBodySchema = Type.Object(
  {
    error: Type.Object(
      {
        code: Type.String(),
        message: Type.String(),
        requestId: Type.String(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'IdentityErrorBody' },
);

export const IDENTITY_ERROR_CODES = [
  'VERIFICATION_REQUEST_ACCEPTED',
  'INVALID_OR_EXPIRED_CHALLENGE',
  'PASSKEY_REGISTRATION_FAILED',
  'PASSKEY_AUTHENTICATION_FAILED',
  'RECOVERY_REQUEST_ACCEPTED',
  'RECOVERY_NOT_AUTHORIZED',
  'ACCOUNT_UNAVAILABLE',
] as const;

export const EmailVerificationRequestSchema = Type.Object(
  {
    email: Type.String({ minLength: 3, maxLength: 320 }),
  },
  { additionalProperties: false, $id: 'EmailVerificationRequest' },
);

export const EmailVerificationCompleteSchema = Type.Object(
  {
    challengeId: Type.String({ format: 'uuid' }),
    code: Type.String({ minLength: 1, maxLength: 128 }),
  },
  { additionalProperties: false, $id: 'EmailVerificationComplete' },
);

export const AcceptedIdentityOperationSchema = Type.Object(
  {
    data: Type.Object(
      {
        status: Type.Union([
          Type.Literal('accepted'),
          Type.Literal('completed'),
          Type.Literal('unavailable'),
        ]),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'AcceptedIdentityOperation' },
);

export const PasskeyRegistrationOptionsRequestSchema = Type.Object(
  {},
  { additionalProperties: false, $id: 'PasskeyRegistrationOptionsRequest' },
);

export const PasskeyRegistrationVerifyRequestSchema = Type.Object(
  {
    challengeId: Type.String({ format: 'uuid' }),
    attestationObject: Type.String({ minLength: 1 }),
    clientDataJSON: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false, $id: 'PasskeyRegistrationVerifyRequest' },
);

export const PasskeyAuthenticationOptionsRequestSchema = Type.Object(
  {},
  { additionalProperties: false, $id: 'PasskeyAuthenticationOptionsRequest' },
);

export const PasskeyAuthenticationVerifyRequestSchema = Type.Object(
  {
    challengeId: Type.String({ format: 'uuid' }),
    credentialId: Type.String({ minLength: 1 }),
    authenticatorData: Type.String({ minLength: 1 }),
    clientDataJSON: Type.String({ minLength: 1 }),
    signature: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false, $id: 'PasskeyAuthenticationVerifyRequest' },
);

export const RecoveryRequestSchema = Type.Object(
  {
    email: Type.String({ minLength: 3, maxLength: 320 }),
  },
  { additionalProperties: false, $id: 'RecoveryRequest' },
);

export const RecoveryVerifyEmailSchema = Type.Object(
  {
    challengeId: Type.String({ format: 'uuid' }),
    code: Type.String({ minLength: 1, maxLength: 128 }),
  },
  { additionalProperties: false, $id: 'RecoveryVerifyEmail' },
);

export const PasskeyListItemSchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    label: Type.Union([Type.String(), Type.Null()]),
    createdAt: Type.String({ format: 'date-time' }),
    lastUsedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  },
  { additionalProperties: false, $id: 'PasskeyListItem' },
);

export const PasskeyListResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        passkeys: Type.Array(PasskeyListItemSchema),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'PasskeyListResponse' },
);

export const FUTURE_IDENTITY_OPERATIONS = [
  {
    method: 'POST',
    path: '/v1/account/email-verifications',
    summary: 'Request email verification challenge',
    request: 'EmailVerificationRequest',
    notes:
      'Future operation. Must not enumerate account existence. Not implemented in this foundation slice.',
  },
  {
    method: 'POST',
    path: '/v1/account/email-verifications/complete',
    summary: 'Complete email verification',
    request: 'EmailVerificationComplete',
    notes: 'Future operation. Not implemented in this foundation slice.',
  },
  {
    method: 'POST',
    path: '/v1/account/passkeys/registration/options',
    summary: 'Begin passkey registration',
    request: 'PasskeyRegistrationOptionsRequest',
    notes: 'Future WebAuthn ceremony. Not implemented in this foundation slice.',
  },
  {
    method: 'POST',
    path: '/v1/account/passkeys/registration/verify',
    summary: 'Verify passkey registration',
    request: 'PasskeyRegistrationVerifyRequest',
    notes: 'Future WebAuthn ceremony. Not implemented in this foundation slice.',
  },
  {
    method: 'POST',
    path: '/v1/auth/passkeys/options',
    summary: 'Begin passkey authentication',
    request: 'PasskeyAuthenticationOptionsRequest',
    notes: 'Future WebAuthn ceremony. Not implemented in this foundation slice.',
  },
  {
    method: 'POST',
    path: '/v1/auth/passkeys/verify',
    summary: 'Verify passkey authentication',
    request: 'PasskeyAuthenticationVerifyRequest',
    notes: 'Future WebAuthn ceremony. Not implemented in this foundation slice.',
  },
  {
    method: 'POST',
    path: '/v1/account/recovery',
    summary: 'Request restricted account recovery',
    request: 'RecoveryRequest',
    notes:
      'Future operation. Recovery grants are restricted authorization, not sessions. Not implemented in this foundation slice.',
  },
  {
    method: 'POST',
    path: '/v1/account/recovery/verify-email',
    summary: 'Verify recovery email challenge',
    request: 'RecoveryVerifyEmail',
    notes: 'Future operation. Not implemented in this foundation slice.',
  },
  {
    method: 'POST',
    path: '/v1/account/recovery/passkeys/registration/options',
    summary: 'Begin recovery passkey registration',
    request: 'PasskeyRegistrationOptionsRequest',
    notes: 'Future operation. Not implemented in this foundation slice.',
  },
  {
    method: 'POST',
    path: '/v1/account/recovery/passkeys/registration/verify',
    summary: 'Verify recovery passkey registration',
    request: 'PasskeyRegistrationVerifyRequest',
    notes: 'Future operation. Not implemented in this foundation slice.',
  },
  {
    method: 'GET',
    path: '/v1/account/passkeys',
    summary: 'List active passkeys for the authenticated account',
    request: null,
    notes: 'Future operation. Not implemented in this foundation slice.',
  },
  {
    method: 'DELETE',
    path: '/v1/account/passkeys/{credentialId}',
    summary: 'Revoke a passkey credential',
    request: null,
    notes:
      'Future operation. Final active passkey for an active account must remain protected. Not implemented in this foundation slice.',
  },
] as const;

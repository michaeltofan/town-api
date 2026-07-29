import { Type, type Static } from '@sinclair/typebox';
import { DomainErrorResponseSchema } from '../../schemas/error.js';
import {
  PasskeyAuthenticationVerifyMobileSuccessSchema,
  PasskeyAuthenticationVerifyWebSuccessSchema,
} from '../passkey-authentication/schemas.js';
import { PASSWORD_SIGN_IN_PASSWORD_MAX_LENGTH } from './policy.js';

const ClientTypeSchema = Type.Union([Type.Literal('web'), Type.Literal('mobile')]);

export const PasswordSignInBodySchema = Type.Object(
  {
    email: Type.String({ minLength: 3, maxLength: 320 }),
    password: Type.String({ minLength: 1, maxLength: PASSWORD_SIGN_IN_PASSWORD_MAX_LENGTH }),
    clientType: ClientTypeSchema,
  },
  { additionalProperties: false },
);

export const PasswordSignInRouteResponses = {
  signIn: {
    200: Type.Union([
      PasskeyAuthenticationVerifyWebSuccessSchema,
      PasskeyAuthenticationVerifyMobileSuccessSchema,
    ]),
    400: DomainErrorResponseSchema,
    404: DomainErrorResponseSchema,
  },
} as const;

export type PasswordSignInBody = Static<typeof PasswordSignInBodySchema>;

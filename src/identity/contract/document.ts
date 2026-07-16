import {
  AcceptedIdentityOperationSchema,
  EmailVerificationCompleteSchema,
  EmailVerificationRequestSchema,
  FUTURE_IDENTITY_OPERATIONS,
  IDENTITY_ERROR_CODES,
  IdentityErrorBodySchema,
  PasskeyAuthenticationOptionsRequestSchema,
  PasskeyAuthenticationVerifyRequestSchema,
  PasskeyListResponseSchema,
  PasskeyRegistrationOptionsRequestSchema,
  PasskeyRegistrationVerifyRequestSchema,
  RecoveryRequestSchema,
  RecoveryVerifyEmailSchema,
} from './schemas.js';

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort((a, b) => a.localeCompare(b))) {
      sorted[key] = sortValue(record[key]);
    }
    return sorted;
  }
  return value;
}

export function serializeIdentityContract(document: unknown): string {
  return `${JSON.stringify(sortValue(document), null, 2)}\n`;
}

export function generateIdentityContractDocument(): unknown {
  return {
    contractVersion: '1.0.0',
    title: 'TOWN Account Identity Architecture Contract V1',
    description:
      'Architecture-only contract for future TOWN account identity endpoints. These operations are not registered as live routes in this foundation slice. Temporary controlled confirmation remains separate from real account identity. This contract is not public authentication documentation for shipping login.',
    status: 'architecture_only',
    implementedLiveRoutes: false,
    domainSeparation: {
      accountIdentity: 'Real account shell, verified email, passkeys, recovery grants',
      civicActor: 'Local civic participation identity, optionally linked 1:1 to an account',
      localVerification: 'Out of scope',
      membershipEntitlement: 'Out of scope; active account does not imply paid membership',
    },
    errorCodes: IDENTITY_ERROR_CODES,
    forbiddenPublicErrorCodes: [
      'EMAIL_NOT_FOUND',
      'EMAIL_ALREADY_REGISTERED',
      'ACCOUNT_EXISTS_FOR_EMAIL',
    ],
    components: {
      schemas: {
        IdentityErrorBody: IdentityErrorBodySchema,
        EmailVerificationRequest: EmailVerificationRequestSchema,
        EmailVerificationComplete: EmailVerificationCompleteSchema,
        AcceptedIdentityOperation: AcceptedIdentityOperationSchema,
        PasskeyRegistrationOptionsRequest: PasskeyRegistrationOptionsRequestSchema,
        PasskeyRegistrationVerifyRequest: PasskeyRegistrationVerifyRequestSchema,
        PasskeyAuthenticationOptionsRequest: PasskeyAuthenticationOptionsRequestSchema,
        PasskeyAuthenticationVerifyRequest: PasskeyAuthenticationVerifyRequestSchema,
        RecoveryRequest: RecoveryRequestSchema,
        RecoveryVerifyEmail: RecoveryVerifyEmailSchema,
        PasskeyListResponse: PasskeyListResponseSchema,
      },
    },
    futureOperations: FUTURE_IDENTITY_OPERATIONS,
    securityNotes: [
      'X-TOWN-Control-Key is unrelated temporary controlled confirmation access and is not account authentication.',
      'No passwords, sessions, cookies, JWTs, or social login in this foundation slice.',
      'Raw verification codes, recovery tokens, and WebAuthn challenges must be stored only as hashes.',
      'Public responses must not enumerate account existence by email.',
    ],
  };
}

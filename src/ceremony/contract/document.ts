import {
  SETUP_GRANT_TTL_MINUTES,
  SESSION_ABSOLUTE_TIMEOUT_HOURS,
  SESSION_IDLE_TIMEOUT_MINUTES,
  SENSITIVE_REAUTH_FRESHNESS_MINUTES,
} from '../policy.js';

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

export function serializeAuthenticationCeremonyContract(document: unknown): string {
  return `${JSON.stringify(sortValue(document), null, 2)}\n`;
}

export function generateAuthenticationCeremonyContractDocument(): unknown {
  return {
    contractVersion: '1.0.0',
    title: 'TOWN Authentication Ceremony Foundation V1',
    description:
      'Architecture contract for ceremony data/session foundation and email verification runtime. Production email delivery, WebAuthn, login/logout, cookies, CSRF, and JWTs remain out of scope.',
    status: 'partially_implemented',
    implementedLiveRoutes: true,
    implementedRoutes: [
      'POST /v1/account/email-verifications',
      'POST /v1/account/email-verifications/complete',
    ],
    slice: 'ceremony_data_and_session_foundation_plus_email_verification_runtime',
    domainSeparation: {
      accountIdentity: 'Account shell, verified email, passkeys, challenges, recovery grants',
      civicActor: 'Local civic participation identity; optionally linked 1:1 to an account',
      authenticationCeremony: 'Challenges, setup grants, WebAuthn challenge records, rate limits',
      authenticatedSession:
        'Opaque server-side account_sessions; not membership or civic entitlement',
      localVerification: 'Out of scope',
      membershipEntitlement: 'Out of scope',
    },
    setupGrants: {
      table: 'town.setup_grants',
      purpose: ['initial_passkey_registration'],
      ttlMinutes: SETUP_GRANT_TTL_MINUTES,
      storage: 'token_hash only; raw tokens never stored',
      semantics: [
        'Restricted pre-authentication authority after email verification and before first passkey registration',
        'Not a session',
        'Cannot access normal account APIs',
        'Cannot perform civic actions',
        'Cannot authorize membership operations',
        'Cannot create a session without completed passkey registration',
        'Active only when unconsumed, unrevoked, unexpired, and account status is pending_passkey',
        'Single-use consumption is concurrency-safe',
      ],
    },
    accountSessions: {
      table: 'town.account_sessions',
      clientTypes: ['web', 'mobile'],
      storage: 'token_hash only; raw session tokens never stored',
      idleTimeoutMinutes: SESSION_IDLE_TIMEOUT_MINUTES,
      absoluteTimeoutHours: SESSION_ABSOLUTE_TIMEOUT_HOURS,
      sensitiveReauthFreshnessMinutes: SENSITIVE_REAUTH_FRESHNESS_MINUTES,
      semantics: [
        'Opaque server-side sessions for future authenticated web and mobile clients',
        'Do not imply membership, payment, local verification, civic entitlement, or Stripe state',
        'Creation requires active account, verified primary email, at least one active passkey, and linked civic actor',
        'Setup grants and recovery grants cannot create sessions',
        'Ordinary activity may extend idle_expires_at but never absolute_expires_at or authenticated_at',
        'idle_expires_at must never exceed absolute_expires_at',
      ],
      rotation: [
        'Replacement session and old-session revocation occur atomically',
        'Old revocation reason is rotated',
        'Old token becomes unusable immediately',
        'Replacement receives a new unique token hash',
        'Exactly one concurrent rotation may succeed',
        'Rotation without reauthentication preserves created_at and authenticated_at',
        'Ordinary rotation may extend idle expiry from the rotation time without extending absolute expiry',
      ],
      revocation: {
        reasons: [
          'logout',
          'logout_all',
          'rotated',
          'account_suspended',
          'account_closed',
          'recovery_completed',
          'credential_compromised',
          'security_version_changed',
        ],
        operations: [
          'revoke one session',
          'revoke all sessions for account',
          'revoke all other sessions for account',
        ],
        notes: [
          'Repeated revocation is deterministic and safe',
          'Repository support exists for suspending/closing accounts by revoking all sessions; routes are out of scope',
        ],
      },
    },
    ceremonyRateLimits: {
      table: 'town.ceremony_rate_limits',
      storage: 'subject_hash only; raw email, IP, credential id, and tokens never stored',
      uniqueness: ['scope', 'subject_hash', 'window_started_at'],
      scopes: [
        'email_verification_request_email',
        'email_verification_request_ip',
        'email_verification_attempt_challenge',
        'email_verification_attempt_email_ip',
        'passkey_options_ip',
        'passkey_options_client',
        'passkey_assertion_credential',
        'passkey_assertion_ip',
        'recovery_request_email',
        'recovery_request_ip',
        'setup_options_grant',
        'setup_verification_grant',
        'recovery_options_grant',
        'recovery_verification_grant',
      ],
      semantics: [
        'Persistent atomic counters for ceremony-specific abuse controls',
        'No Redis and no live enforcement middleware in this slice',
        'Hashing/normalization belongs to future ceremony adapters',
      ],
    },
    identitySecurityEventTypes: {
      preserved: [
        'email_verification_requested',
        'email_verified',
        'passkey_registered',
        'passkey_used',
        'passkey_revoked',
        'recovery_requested',
        'recovery_completed',
        'account_suspended',
        'account_closed',
      ],
      added: [
        'authentication_failed',
        'session_created',
        'session_rotated',
        'session_revoked',
        'counter_anomaly_detected',
        'rate_limit_triggered',
      ],
    },
    grantVersusSessionDistinction: {
      setupGrant: 'Restricted setup authority before first passkey; not authenticated access',
      recoveryGrant:
        'Restricted recovery authority; revokes sessions; does not create a normal session',
      accountSession: 'Opaque authenticated session after eligible active account authentication',
    },
    futureCookiePolicyArchitectureOnly: {
      status: 'architecture_only',
      notes: [
        'Future web clients may use HttpOnly Secure SameSite cookies binding an opaque session identifier',
        'Cookies are not implemented in this slice',
        'CSRF protections for cookie-authenticated mutating routes are future work',
      ],
    },
    futureRpIdAndOriginPolicyArchitectureOnly: {
      status: 'architecture_only',
      productionRpId: 'towncivic.org',
      initialProductionWebOrigin: 'https://towncivic.org',
      notes: [
        'Staging, development, and production credentials must remain isolated',
        'Temporary Railway, preview, GitHub Pages, or other temporary domains must never register production credentials',
        'No RP ID or origin runtime configuration is shipped in this slice',
      ],
    },
    emailVerificationRuntime: {
      status: 'implemented',
      featureFlag: 'EMAIL_VERIFICATION_ENABLED',
      routes: [
        'POST /v1/account/email-verifications',
        'POST /v1/account/email-verifications/complete',
      ],
      codePolicy: {
        length: 6,
        ttlMinutes: 10,
        maxAttempts: 5,
        storage: 'HMAC-SHA-256 secret_hash only',
      },
      antiEnumeration: true,
      createsSession: false,
      activatesAccount: false,
      transitions: ['pending_email -> pending_passkey'],
      issues: ['restricted setup grant initial_passkey_registration'],
      deliveryModes: ['test', 'development'],
    },
    explicitExclusions: [
      'production email provider',
      'WebAuthn options or verification',
      'login routes',
      'logout endpoints',
      'recovery runtime',
      'cookies',
      'CSRF',
      'JWTs',
      'membership',
      'Stripe',
      'local verification',
      'Railway',
      'web integration',
      'mobile integration',
      'deployment',
      'Redis',
    ],
  };
}

import swagger from '@fastify/swagger';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

const openApiPlugin: FastifyPluginAsync = async (app) => {
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'TOWN API',
        description:
          'TOWN API civic foundation for the responsive web launch — health probes, communities, published signals, temporary controlled signal confirmation (read-only) plus session-authenticated participant signal confirmation, gated email verification, first-passkey WebAuthn registration, passkey authentication sessions, bounded account recovery, session-authenticated passkey management, session-authenticated membership entitlement read, and flag-gated Stripe Checkout, Customer Portal, and signature-verified Stripe webhook processing. Controlled confirmation reads, email verification, setup-grant passkey registration, and recovery grants are not public authentication or login sessions. Membership foundation is separate from account identity. Stripe is the sole membership payment provider for the current web launch; Google Play purchase and RTDN ingress remain in-tree but flag-gated off by default and outside the current critical path. Flutter, Apple In-App Purchase, and native app-store distribution are outside the current product path.',
        version: '0.1.0',
      },
      tags: [
        {
          name: 'Health',
          description: 'Liveness and readiness probes',
        },
        {
          name: 'Communities',
          description: 'Active local communities',
        },
        {
          name: 'Signals',
          description: 'Published civic signals',
        },
        {
          name: 'Confirmations',
          description:
            'GET returns participant own-confirmation state when session-authenticated, or the temporary controlled-test-actor state when X-TOWN-Control-Key is supplied. PUT is the session-authenticated civic participant confirmation route requiring an active Session, participant civic access, a linked civic actor for the signal community, and fail-closed local participation eligibility. Responses include an aggregate confirmationCount integer only — never actor identifiers, confirmer lists, or social reaction mechanics.',
        },
        {
          name: 'Discussion',
          description:
            'Session-authenticated civic discussion sessions on published signals. Paying participants with access.canParticipate can read a signal discussion session and publish structured contributions (observation, proposal, next_step) toward a local solution. Not chat, comments, reactions, or social threading. Never exposes actor or account identifiers.',
        },
        {
          name: 'Account',
          description:
            'Account setup email verification, flag-gated initial password setup (POST /v1/account/password), flag-gated session-authenticated password change (POST /v1/account/password/change), first-passkey WebAuthn registration, bounded account recovery, session-authenticated passkey management, session-authenticated membership entitlement inventory read at GET /v1/account/membership, and flag-gated set-once local eligibility bind at PUT /v1/account/eligibility. Initial password setup and first-passkey registration require purpose-bound SetupGrant tokens. Password change and passkey management require an active Session only. Recovery grants are restricted authorization, not sessions. Membership inventory never exposes Stripe customer or subscription identifiers. PASSWORD_AUTH_ENABLED, PASSWORD_CHANGE_ENABLED, and LOCAL_ELIGIBILITY_ENABLED default to false.',
        },
        {
          name: 'Authentication',
          description:
            'Passkey authentication, flag-gated public password sign-in (POST /v1/authentication/password), and opaque account sessions. Passkey options/verify are gated by PASSKEY_AUTHENTICATION_ENABLED; password sign-in by PASSWORD_SIGN_IN_ENABLED. Shared session introspection, rotation, and logout are available when either flag is enabled. Web clients use only the Secure HttpOnly session cookie; mobile clients use only Authorization: Session <token>. Sessions do not grant membership, payment, local verification, or civic entitlement. Both flags default to false.',
        },
        {
          name: 'Billing',
          description:
            'Stripe is the sole membership payment provider for the TOWN web launch. Flag-gated Checkout and Customer Portal require an active session; POST /v1/billing/stripe/webhook verifies raw Stripe signatures. Never exposes Stripe customer/subscription/invoice identifiers in public API responses; only Stripe-issued Checkout/Portal URLs and bounded membership status are returned. Google Play purchase and RTDN ingress remain in-tree for historical native-store work, stay flag-gated off by default (GOOGLE_PLAY_BILLING_ENABLED / GOOGLE_PLAY_RTDN_INGRESS_ENABLED), and are outside the current critical path. When enabled, Google Play purchase ingress acknowledges purchases only after durable paid_pending_binding provision and does not process RTDN, voided purchases, refunds, or finalize binding to active. Flutter, Apple In-App Purchase, and native app-store distribution are outside the current product path.',
        },
      ],
      components: {
        securitySchemes: {
          TownControlKey: {
            type: 'apiKey',
            in: 'header',
            name: 'X-TOWN-Control-Key',
            description:
              'Temporary controlled test mechanism for confirmation routes. Not public authentication. Do not treat this as a user session, OAuth token, or production identity system. Example secret values are intentionally omitted.',
          },
          setupGrantAuth: {
            type: 'apiKey',
            in: 'header',
            name: 'Authorization',
            description:
              'Restricted setup-grant authorization for initial password setup (purpose initial_password_setup) and first-passkey registration (purpose initial_passkey_registration). Exact header form: Authorization: SetupGrant <opaque-token>. Purpose is bound into the token hash; a grant never authorizes both steps. Not an account session and not a Bearer token.',
          },
          recoveryGrantAuth: {
            type: 'apiKey',
            in: 'header',
            name: 'Authorization',
            description:
              'Restricted recovery-grant authorization for recovery passkey registration. Exact header form: Authorization: RecoveryGrant <opaque-token>. Not an account session and not a Bearer token.',
          },
          sessionAuth: {
            type: 'apiKey',
            in: 'cookie',
            name: '__Host-Http-town_session',
            description:
              'Web-only opaque session cookie. The runtime sets it as Secure, HttpOnly, SameSite=Lax, Path=/, with no Domain. Mutative cookie-authenticated routes require same-origin/same-site CSRF evidence.',
          },
          mobileSessionAuth: {
            type: 'apiKey',
            in: 'header',
            name: 'Authorization',
            description:
              'Mobile-only opaque session transport. Exact header form: Authorization: Session <opaque-token>. Not a Bearer token and not accepted for web cookie sessions.',
          },
        },
      },
    },
  });
};

export default fp(openApiPlugin, {
  name: 'openapi',
});

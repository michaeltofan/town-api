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
          'TOWN API civic foundation — health probes, communities, published signals, temporary controlled signal confirmation, gated email verification, first-passkey WebAuthn registration, passkey authentication sessions, and bounded account recovery. Controlled confirmation, email verification, setup-grant passkey registration, and recovery grants are not public authentication or login sessions.',
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
            'Temporary controlled signal confirmation for a single seeded test actor. Not public authentication, membership, or social counting.',
        },
        {
          name: 'Account',
          description:
            'Account setup email verification, first-passkey WebAuthn registration, and bounded account recovery. Recovery grants are restricted authorization, not sessions. Routes do not create login sessions or disclose account existence beyond protocol-required WebAuthn options.',
        },
        {
          name: 'Authentication',
          description:
            'Passkey authentication and opaque account sessions. Web clients use only the Secure HttpOnly session cookie; mobile clients use only Authorization: Session <token>. Sessions do not grant membership, payment, local verification, or civic entitlement.',
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
              'Restricted setup-grant authorization for first-passkey registration. Exact header form: Authorization: SetupGrant <opaque-token>. Not an account session and not a Bearer token.',
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

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
          'TOWN API civic foundation — health probes, communities, published signals, temporary controlled signal confirmation, and gated email verification for account setup. Controlled confirmation and email verification are not public authentication.',
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
            'Account setup email verification. Does not create sessions, activate accounts, or disclose account existence.',
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
        },
      },
    },
  });
};

export default fp(openApiPlugin, {
  name: 'openapi',
});

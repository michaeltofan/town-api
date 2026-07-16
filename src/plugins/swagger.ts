import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

const swaggerPlugin: FastifyPluginAsync = async (app) => {
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'TOWN API',
        description: 'TOWN API foundation — health and platform scaffolding only.',
        version: '0.1.0',
      },
      tags: [
        {
          name: 'Health',
          description: 'Liveness and readiness probes',
        },
      ],
      servers: [
        {
          url: 'http://localhost:3000',
          description: 'Local development',
        },
      ],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    staticCSP: true,
    uiConfig: {
      docExpansion: 'list',
      deepLinking: false,
    },
  });
};

export default fp(swaggerPlugin, {
  name: 'swagger',
});

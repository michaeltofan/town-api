import type { FastifyPluginCallback } from 'fastify';
import fp from 'fastify-plugin';
import type { Database } from './client.js';

export type DatabasePluginOptions = {
  database: Database;
};

const databasePlugin: FastifyPluginCallback<DatabasePluginOptions> = (app, options, done) => {
  app.decorate('database', options.database);

  app.addHook('onClose', async () => {
    await options.database.close();
  });

  done();
};

export default fp(databasePlugin, {
  name: 'database',
});

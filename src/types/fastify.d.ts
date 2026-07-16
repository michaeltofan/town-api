import type { Env } from '../config/env.js';
import type { Database } from '../db/client.js';

declare module 'fastify' {
  // Fastify declaration merging requires an interface.
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- module augmentation
  export interface FastifyInstance {
    database: Database;
    townEnv: Env;
  }
}

export {};

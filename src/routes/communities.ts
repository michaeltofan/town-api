import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { listActiveCommunities } from '../db/repositories/communities.js';
import { CommunitiesListResponseSchema, type PublicCommunity } from '../schemas/communities.js';
import type { CommunityRow } from '../db/schema.js';

function toPublicCommunity(row: CommunityRow): PublicCommunity {
  return {
    id: row.id,
    slug: row.slug,
    position: row.position,
    countryCode: row.countryCode,
    cityName: row.cityName,
    displayName: row.displayName,
    defaultLocale: row.defaultLocale,
    timezone: row.timezone,
  };
}

export const communitiesRoutes: FastifyPluginCallbackTypebox = (app, _opts, done) => {
  app.get(
    '/v1/communities',
    {
      schema: {
        tags: ['Communities'],
        summary: 'List active communities',
        response: {
          200: CommunitiesListResponseSchema,
        },
      },
    },
    async () => {
      const rows = await listActiveCommunities(app.database.db);
      return {
        data: rows.map(toPublicCommunity),
      };
    },
  );

  done();
};

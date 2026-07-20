import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { findActiveCommunityBySlug } from '../db/repositories/communities.js';
import {
  findPublishedSignalById,
  listPublishedSignalsForCommunity,
} from '../db/repositories/signals.js';
import { communityNotFoundError, signalNotFoundError } from '../errors/app-error.js';
import { CommunitySlugParamsSchema } from '../schemas/communities.js';
import {
  CommunitySignalsResponseSchema,
  SignalDetailResponseSchema,
  SignalIdParamsSchema,
} from '../schemas/signals.js';
import { DomainErrorResponseSchema } from '../schemas/error.js';
import type { SignalRow } from '../db/schema.js';
import { toIsoTimestamp } from '../lib/timestamps.js';

function toSignalListItem(row: SignalRow) {
  return {
    id: row.id,
    slug: row.slug,
    position: row.position,
    locale: row.locale,
    category: row.category,
    area: row.area,
    headline: row.headline,
    summary: row.summary,
    observedLabel: row.observedLabel,
    imageKey: row.imageKey,
    imageFocus: {
      x: row.imageFocusX,
      y: row.imageFocusY,
    },
  };
}

export const signalsRoutes: FastifyPluginCallbackTypebox = (app, _opts, done) => {
  app.get(
    '/v1/communities/:communitySlug/signals',
    {
      schema: {
        tags: ['Signals'],
        summary: 'List published signals for a community',
        params: CommunitySlugParamsSchema,
        response: {
          200: CommunitySignalsResponseSchema,
          404: DomainErrorResponseSchema,
        },
      },
    },
    async (request) => {
      const community = await findActiveCommunityBySlug(
        app.database.db,
        request.params.communitySlug,
      );

      if (!community) {
        throw communityNotFoundError();
      }

      const rows = await listPublishedSignalsForCommunity(app.database.db, community.id);

      return {
        data: {
          community: {
            id: community.id,
            slug: community.slug,
            displayName: community.displayName,
            defaultLocale: community.defaultLocale,
          },
          signals: rows.map(toSignalListItem),
        },
      };
    },
  );

  app.get(
    '/v1/signals/:signalId',
    {
      schema: {
        tags: ['Signals'],
        summary: 'Get one published signal by UUID',
        params: SignalIdParamsSchema,
        response: {
          200: SignalDetailResponseSchema,
          400: DomainErrorResponseSchema,
          404: DomainErrorResponseSchema,
        },
      },
    },
    async (request) => {
      const result = await findPublishedSignalById(app.database.db, request.params.signalId);

      if (!result) {
        throw signalNotFoundError();
      }

      const { signal, community } = result;

      return {
        data: {
          id: signal.id,
          slug: signal.slug,
          community: {
            id: community.id,
            slug: community.slug,
            displayName: community.displayName,
          },
          locale: signal.locale,
          category: signal.category,
          area: signal.area,
          headline: signal.headline,
          summary: signal.summary,
          description: signal.description,
          whyItMatters: signal.whyItMatters,
          whoIsAffected: signal.whoIsAffected,
          latestUpdate: signal.latestUpdate,
          statusLabel: signal.statusLabel,
          statusNote: signal.statusNote,
          observedLabel: signal.observedLabel,
          observedOn: signal.observedOn,
          observedPrecision: signal.observedPrecision as 'day' | 'week',
          authorDisplayName: signal.authorDisplayName,
          imageKey: signal.imageKey,
          imageFocus: {
            x: signal.imageFocusX,
            y: signal.imageFocusY,
          },
          publishedAt: toIsoTimestamp(signal.publishedAt),
        },
      };
    },
  );

  done();
};

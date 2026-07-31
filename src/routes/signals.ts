import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { findActiveCommunityBySlug } from '../db/repositories/communities.js';
import { countConfirmationsForSignals } from '../db/repositories/confirmations.js';
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
import { memberSignalMediaProxyPath } from '../membership/member-signal-policy.js';

function toImageMedia(row: SignalRow) {
  if (!row.mediaUploadId) {
    return null;
  }
  return {
    url: memberSignalMediaProxyPath(row.id),
  };
}

function toSignalListItem(row: SignalRow, confirmationCount: number) {
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
    imageMedia: toImageMedia(row),
    confirmationCount,
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
      const confirmationTotals = await countConfirmationsForSignals(
        app.database.db,
        rows.map((row) => row.id),
      );

      return {
        data: {
          community: {
            id: community.id,
            slug: community.slug,
            displayName: community.displayName,
            defaultLocale: community.defaultLocale,
          },
          signals: rows.map((row) => toSignalListItem(row, confirmationTotals.get(row.id) ?? 0)),
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
      const confirmationTotals = await countConfirmationsForSignals(app.database.db, [signal.id]);

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
          imageMedia: toImageMedia(signal),
          publishedAt: toIsoTimestamp(signal.publishedAt),
          confirmationCount: confirmationTotals.get(signal.id) ?? 0,
        },
      };
    },
  );

  done();
};

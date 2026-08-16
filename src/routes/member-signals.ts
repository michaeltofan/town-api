import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { randomUUID } from 'node:crypto';
import type { Env } from '../config/env.js';
import { requirePasskeyManagementConfig } from '../ceremony/passkey-management/config.js';
import { assertWebCookieCsrf } from '../ceremony/passkey-authentication/csrf.js';
import {
  parseSessionAuthorizationHeader,
  parseWebSessionCookie,
  type SessionTransportExtraction,
} from '../ceremony/passkey-authentication/session-transport.js';
import { resolveActiveSession } from '../ceremony/passkey-authentication/service.js';
import { CIVIC_ACTOR_DISPLAY_LABEL } from '../ceremony/passkey-registration/policy.js';
import { findActiveCommunityBySlug } from '../db/repositories/communities.js';
import { findActiveCivicActorByAccountId } from '../db/repositories/confirmations.js';
import {
  countAccountMemberSignalsSince,
  findAttachableSignalMediaUpload,
  findSignalMediaUploadById,
  insertPendingSignalMediaUpload,
  markSignalMediaUploadAttached,
  nextSignalPositionForCommunity,
} from '../db/repositories/signal-media.js';
import {
  findPublishedSignalById,
  insertPublishedMemberSignal,
  updateCivicActorDisplayLabel,
} from '../db/repositories/signals.js';
import { findAccountById, lockAccountById } from '../identity/repositories/accounts.js';
import { toIsoTimestamp } from '../lib/timestamps.js';
import {
  AppError,
  civicParticipationNotAuthorizedError,
  communityCommitmentAcceptanceRequiredError,
  communityNotFoundError,
  contributionMediaNotFoundError,
  mediaUploadFailedError,
  objectStorageNotAvailableError,
  rateLimitedError,
  signalNotFoundError,
} from '../errors/app-error.js';
import { evaluateCivicAccess } from '../membership/civic-access.js';
import { hasValidCommunityCommitment } from '../membership/community-commitment.js';
import { memberSignalEditorialCopy } from '../membership/member-signal-copy.js';
import {
  buildMemberSignalMediaObjectKey,
  buildMemberSignalSlug,
  isAllowedMemberSignalCategory,
  isAllowedMemberSignalMediaContentType,
  matchesMemberSignalMediaMagic,
  MAX_MEMBER_SIGNAL_DESCRIPTION_LENGTH,
  MAX_MEMBER_SIGNAL_IMAGE_BYTES,
  MAX_MEMBER_SIGNAL_TITLE_LENGTH,
  MEMBER_SIGNAL_ACCOUNT_LIMIT_24H,
  MEMBER_SIGNAL_MEDIA_CONTENT_TYPES,
  MEMBER_SIGNAL_MEDIA_UPLOAD_TTL_MS,
  memberSignalImageKeyPlaceholder,
  memberSignalMediaProxyPath,
  MIN_MEMBER_SIGNAL_DESCRIPTION_LENGTH,
  MIN_MEMBER_SIGNAL_TITLE_LENGTH,
  normalizeMemberSignalRealName,
  truncateSummary,
} from '../membership/member-signal-policy.js';
import {
  CommunitySlugParamsSchema,
  MemberSignalCreateBodySchema,
  MemberSignalRouteResponses,
} from '../membership/member-signal-schemas.js';
import {
  createDefaultLocalEligibilityResolver,
  type LocalParticipationEligibilityResolver,
} from '../membership/local-eligibility.js';
import { findEntitlementByAccountId } from '../membership/repositories/entitlements.js';
import { rollingWindowStartIso } from '../db/repositories/signal-submissions.js';
import { ERROR_CODE } from '../schemas/error.js';
import { SignalIdParamsSchema } from '../schemas/signals.js';
import type { TownObjectStorageAdapter } from '../storage/object-storage-adapter.js';

export type MemberSignalRoutesOptions = {
  env: Env;
  now?: () => string;
  generateId?: () => string;
  localEligibilityResolver?: LocalParticipationEligibilityResolver;
  objectStorageAdapter?: TownObjectStorageAdapter | null;
};

function sessionNotAuthorizedError(): AppError {
  return new AppError(401, 'SESSION_NOT_AUTHORIZED', 'Session is not authorized.');
}

function validationError(message = 'Request validation failed.'): AppError {
  return new AppError(400, ERROR_CODE.VALIDATION_ERROR, message);
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function extractSessionTransport(input: {
  authorization: string | string[] | undefined;
  cookieName: string;
  cookies: Record<string, string | undefined> | undefined;
}): SessionTransportExtraction {
  const web = parseWebSessionCookie({
    cookieName: input.cookieName,
    cookies: input.cookies,
  });
  if (web.ok) {
    return web;
  }
  return parseSessionAuthorizationHeader(input.authorization);
}

function rejectNonSessionSchemes(authorization: string | string[] | undefined): void {
  const raw = Array.isArray(authorization) ? authorization[0] : authorization;
  if (raw === undefined || raw.length === 0) {
    return;
  }
  const space = raw.indexOf(' ');
  if (space <= 0) {
    return;
  }
  const scheme = raw.slice(0, space);
  if (scheme === 'SetupGrant' || scheme === 'RecoveryGrant' || scheme === 'Bearer') {
    throw sessionNotAuthorizedError();
  }
}

function assertWebCsrf(input: {
  originHeader: string | undefined;
  secFetchSite: string | undefined;
  allowedOrigins: readonly string[];
}): void {
  const csrf = assertWebCookieCsrf(input);
  if (!csrf.ok) {
    throw sessionNotAuthorizedError();
  }
}

function parseUploadBody(raw: unknown): Buffer {
  if (Buffer.isBuffer(raw)) {
    return raw;
  }
  if (raw instanceof Uint8Array) {
    return Buffer.from(raw);
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw);
  }
  throw validationError('Request body must be raw binary image bytes.');
}

function observedOnDate(nowIso: string): string {
  return nowIso.slice(0, 10);
}

export const memberSignalRoutes: FastifyPluginCallbackTypebox<MemberSignalRoutesOptions> = (
  app,
  options,
  done,
) => {
  const { env } = options;
  const now = () => (options.now ?? (() => new Date().toISOString()))();
  const generateId = options.generateId ?? (() => randomUUID());
  const objectStorageAdapter = options.objectStorageAdapter ?? null;
  const resolver: LocalParticipationEligibilityResolver =
    options.localEligibilityResolver ??
    createDefaultLocalEligibilityResolver({
      localEligibilityEnabled: env.LOCAL_ELIGIBILITY_ENABLED,
    });

  for (const contentType of MEMBER_SIGNAL_MEDIA_CONTENT_TYPES) {
    app.addContentTypeParser(
      contentType,
      { parseAs: 'buffer', bodyLimit: MAX_MEMBER_SIGNAL_IMAGE_BYTES },
      (_request, body, next) => {
        next(null, body);
      },
    );
  }

  async function requireSession(request: {
    headers: {
      authorization?: string | string[] | undefined;
      origin?: string | string[] | undefined;
      'sec-fetch-site'?: string | string[] | undefined;
    };
    cookies?: Record<string, string | undefined>;
    mutative?: boolean;
  }): Promise<NonNullable<Awaited<ReturnType<typeof resolveActiveSession>>>> {
    rejectNonSessionSchemes(request.headers.authorization);
    const config = requirePasskeyManagementConfig(env);
    const extracted = extractSessionTransport({
      authorization: request.headers.authorization,
      cookieName: config.webSessionCookieName,
      cookies: request.cookies,
    });
    if (!extracted.ok) {
      throw sessionNotAuthorizedError();
    }
    if (extracted.clientType === 'web' && request.mutative !== false) {
      assertWebCsrf({
        originHeader: singleHeader(request.headers.origin),
        secFetchSite: singleHeader(request.headers['sec-fetch-site']),
        allowedOrigins: config.allowedOrigins,
      });
    }
    const session = await resolveActiveSession(
      app.database.db,
      { env, now },
      {
        clientType: extracted.clientType,
        token: extracted.token,
      },
    );
    if (!session) {
      throw sessionNotAuthorizedError();
    }
    return session;
  }

  async function requireParticipantInCommunity(input: {
    sessionAccountId: string;
    communitySlug: string;
  }) {
    const community = await findActiveCommunityBySlug(app.database.db, input.communitySlug);
    if (!community) {
      throw communityNotFoundError();
    }

    const actor = await findActiveCivicActorByAccountId(app.database.db, input.sessionAccountId);
    if (!actor) {
      throw civicParticipationNotAuthorizedError();
    }

    const nowIso = now();
    const [account, entitlement] = await Promise.all([
      findAccountById(app.database.db, input.sessionAccountId),
      findEntitlementByAccountId(app.database.db, input.sessionAccountId),
    ]);

    const localEligibility = await Promise.resolve(
      resolver({
        accountId: input.sessionAccountId,
        actorId: actor.id,
        communityId: community.id,
        actor,
      }),
    );

    const access = evaluateCivicAccess({
      session: { accountId: input.sessionAccountId },
      account: account
        ? { id: account.id, status: account.status, isOwner: account.isOwner }
        : null,
      entitlement,
      actor,
      communityId: community.id,
      localEligibility,
      now: nowIso,
    });

    if (access.level !== 'participant' || !access.canParticipate) {
      throw civicParticipationNotAuthorizedError();
    }

    if (!hasValidCommunityCommitment(actor)) {
      throw civicParticipationNotAuthorizedError();
    }

    return { community, actor, nowIso };
  }

  app.post(
    '/v1/communities/:communitySlug/signals/media',
    {
      schema: {
        tags: ['Signals'],
        summary: 'Upload a photo for a new member civic signal',
        description:
          'Uploads a JPEG/PNG/WebP photo into private object storage and returns a pending mediaUploadId. ' +
          'Attach that id when publishing a member signal. Requires participant civic access for the path community, ' +
          'including an existing community commitment. Not a public bucket URL.',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        params: CommunitySlugParamsSchema,
        response: MemberSignalRouteResponses.mediaUpload,
      },
      bodyLimit: MAX_MEMBER_SIGNAL_IMAGE_BYTES,
    },
    async (request, reply) => {
      if (!env.PASSKEY_AUTHENTICATION_ENABLED) {
        reply.callNotFound();
        return;
      }
      if (!objectStorageAdapter) {
        throw objectStorageNotAvailableError();
      }

      const session = await requireSession({
        headers: request.headers,
        cookies: request.cookies,
        mutative: true,
      });
      const { community, actor, nowIso } = await requireParticipantInCommunity({
        sessionAccountId: session.accountId,
        communitySlug: request.params.communitySlug,
      });

      const contentTypeHeader = (singleHeader(request.headers['content-type']) ?? '')
        .split(';')[0]
        ?.trim()
        .toLowerCase();
      if (!contentTypeHeader || !isAllowedMemberSignalMediaContentType(contentTypeHeader)) {
        throw validationError('Content-Type must be image/jpeg, image/png, or image/webp.');
      }
      const bytes = parseUploadBody(request.body);
      if (bytes.byteLength === 0) {
        throw validationError('Image body must not be empty.');
      }
      if (!matchesMemberSignalMediaMagic(contentTypeHeader, bytes)) {
        throw validationError(
          'Image bytes do not match the declared Content-Type (magic-byte check failed).',
        );
      }
      if (bytes.byteLength > MAX_MEMBER_SIGNAL_IMAGE_BYTES) {
        throw validationError(
          `Image exceeds maximum size of ${String(MAX_MEMBER_SIGNAL_IMAGE_BYTES)} bytes.`,
        );
      }

      const mediaUploadId = generateId();
      const objectKey = buildMemberSignalMediaObjectKey({
        communityId: community.id,
        uploadId: mediaUploadId,
        contentType: contentTypeHeader,
      });
      const putResult = await objectStorageAdapter.putObject({
        key: objectKey,
        body: bytes,
        contentType: contentTypeHeader,
      });
      if (!putResult.ok) {
        throw mediaUploadFailedError();
      }

      const expiresAt = new Date(
        Date.parse(nowIso) + MEMBER_SIGNAL_MEDIA_UPLOAD_TTL_MS,
      ).toISOString();
      await insertPendingSignalMediaUpload(app.database.db, {
        id: mediaUploadId,
        communityId: community.id,
        accountId: session.accountId,
        actorId: actor.id,
        objectKey,
        contentType: contentTypeHeader,
        byteSize: bytes.byteLength,
        createdAt: nowIso,
        expiresAt,
      });

      // Etapa 5: structured, greppable-from-deployment-logs cost/traffic
      // telemetry -- nested under a single `mediaUpload` key so it survives
      // Railway's log-attribute flattening the same way `capacityDbMonitor`
      // and `capacitySetupResult` already do (see db-monitor.ts /
      // run-capacity-setup.ts), instead of relying on unverified behavior
      // for separate scalar attributes.
      app.log.info(
        {
          mediaUpload: {
            route: 'member_signal',
            contentType: contentTypeHeader,
            byteSize: bytes.byteLength,
          },
        },
        'member-signal media uploaded',
      );

      return await reply.status(201).send({
        data: {
          mediaUploadId,
          contentType: contentTypeHeader,
          byteSize: bytes.byteLength,
          expiresAt: toIsoTimestamp(expiresAt),
        },
      });
    },
  );

  app.post(
    '/v1/communities/:communitySlug/signals',
    {
      schema: {
        tags: ['Signals'],
        summary: 'Publish a member civic signal immediately',
        description:
          "Creates a published civic signal in the member's own community under their real name. " +
          'Requires session auth, canParticipate, and an existing community commitment. ' +
          'acceptedResponsibility must be true and reaffirms existing membership personal-responsibility rules — ' +
          'it does not create a second agreement type. Publishes immediately (no pending_review approval queue).',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        params: CommunitySlugParamsSchema,
        body: MemberSignalCreateBodySchema,
        response: MemberSignalRouteResponses.create,
      },
    },
    async (request, reply) => {
      if (!env.PASSKEY_AUTHENTICATION_ENABLED) {
        reply.callNotFound();
        return;
      }
      if (!objectStorageAdapter) {
        throw objectStorageNotAvailableError();
      }

      const session = await requireSession({
        headers: request.headers,
        cookies: request.cookies,
        mutative: true,
      });

      if (!request.body.acceptedResponsibility) {
        // Reuses the existing acceptance-required error for personal responsibility.
        throw communityCommitmentAcceptanceRequiredError();
      }

      const title = request.body.title.trim();
      const description = request.body.description.trim();
      if (
        title.length < MIN_MEMBER_SIGNAL_TITLE_LENGTH ||
        title.length > MAX_MEMBER_SIGNAL_TITLE_LENGTH ||
        description.length < MIN_MEMBER_SIGNAL_DESCRIPTION_LENGTH ||
        description.length > MAX_MEMBER_SIGNAL_DESCRIPTION_LENGTH
      ) {
        throw validationError();
      }
      if (!isAllowedMemberSignalCategory(request.body.category)) {
        throw validationError('category is not an allowed civic signal category.');
      }
      const realName = normalizeMemberSignalRealName(request.body.realName);
      if (!realName) {
        throw validationError(
          'realName must be your real name (given and family name), not a username or handle.',
        );
      }

      const { community, actor, nowIso } = await requireParticipantInCommunity({
        sessionAccountId: session.accountId,
        communitySlug: request.params.communitySlug,
      });

      const pending = await findAttachableSignalMediaUpload(app.database.db, {
        mediaUploadId: request.body.mediaUploadId,
        communityId: community.id,
        accountId: session.accountId,
        now: nowIso,
      });
      if (!pending) {
        throw validationError(
          'mediaUploadId is not a pending photo owned by this account for this community.',
        );
      }

      const signalId = generateId();
      const editorial = memberSignalEditorialCopy(community.defaultLocale);

      const created = await app.database.db.transaction(async (tx) => {
        const locked = await lockAccountById(tx, session.accountId);
        if (!locked) {
          throw new Error('Member signal publish requires an existing account');
        }

        const since = rollingWindowStartIso(nowIso);
        const existing = await countAccountMemberSignalsSince(tx, {
          accountId: session.accountId,
          since,
        });
        if (existing >= MEMBER_SIGNAL_ACCOUNT_LIMIT_24H) {
          throw rateLimitedError();
        }

        const position = await nextSignalPositionForCommunity(tx, community.id);
        const row = await insertPublishedMemberSignal(tx, {
          id: signalId,
          communityId: community.id,
          slug: buildMemberSignalSlug(title, signalId),
          position,
          locale: community.defaultLocale,
          category: request.body.category,
          area: community.displayName,
          headline: title,
          summary: truncateSummary(description),
          description,
          whyItMatters: editorial.whyItMatters,
          whoIsAffected: editorial.whoIsAffected,
          latestUpdate: editorial.latestUpdate,
          statusLabel: editorial.statusLabel,
          statusNote: editorial.statusNote,
          observedLabel: editorial.observedLabel,
          observedOn: observedOnDate(nowIso),
          authorDisplayName: realName,
          authorActorId: actor.id,
          authorAccountId: session.accountId,
          mediaUploadId: pending.id,
          imageKey: memberSignalImageKeyPlaceholder(signalId),
          now: nowIso,
        });

        await markSignalMediaUploadAttached(tx, pending.id);

        if (actor.displayLabel === CIVIC_ACTOR_DISPLAY_LABEL) {
          await updateCivicActorDisplayLabel(tx, {
            actorId: actor.id,
            displayLabel: realName,
          });
        }

        return row;
      });

      return await reply.status(201).send({
        data: {
          id: created.id,
          slug: created.slug,
          status: 'published' as const,
          community: { slug: community.slug },
          authorDisplayName: created.authorDisplayName,
          imageMedia: {
            contentType: pending.contentType,
            byteSize: pending.byteSize,
            url: memberSignalMediaProxyPath(created.id),
          },
          publishedAt: toIsoTimestamp(created.publishedAt),
        },
      });
    },
  );

  /**
   * Public media proxy for published member-signal photos.
   * Foundation signals use static imageKey assets and have no media_upload_id.
   */
  app.get(
    '/v1/signals/:signalId/media',
    {
      schema: {
        tags: ['Signals'],
        summary: 'Fetch the photo for a published member signal',
        description:
          'Streams the securely stored photo for a published member-authored signal. ' +
          'Public for published visible signals (same visibility as the signal itself).',
        params: SignalIdParamsSchema,
      },
    },
    async (request, reply) => {
      if (!objectStorageAdapter) {
        throw objectStorageNotAvailableError();
      }

      const published = await findPublishedSignalById(app.database.db, request.params.signalId);
      if (!published?.signal.mediaUploadId) {
        throw signalNotFoundError();
      }

      const upload = await findSignalMediaUploadById(
        app.database.db,
        published.signal.mediaUploadId,
      );
      if (upload?.status !== 'attached') {
        throw contributionMediaNotFoundError();
      }

      const object = await objectStorageAdapter.getObject({ key: upload.objectKey });
      if (!object.ok) {
        throw contributionMediaNotFoundError();
      }

      reply
        .header('Content-Type', upload.contentType)
        .header('Content-Length', String(object.body.byteLength))
        .header('Cache-Control', 'public, max-age=300')
        .header('X-Content-Type-Options', 'nosniff');
      return reply.send(object.body);
    },
  );

  done();
};

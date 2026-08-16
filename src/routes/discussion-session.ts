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
import { findActiveCivicActorByAccountId } from '../db/repositories/confirmations.js';
import {
  findAttachableDiscussionMediaUpload,
  findDiscussionMediaUploadById,
  insertPendingDiscussionMediaUpload,
  markDiscussionMediaUploadAttached,
} from '../db/repositories/discussion-media.js';
import {
  ensureDiscussionSessionForSignal,
  findDiscussionContributionForSignal,
  insertDiscussionContribution,
  listDiscussionContributionsForSession,
  type DiscussionContributionView,
} from '../db/repositories/discussion-session.js';
import { findPublishedSignalById } from '../db/repositories/signals.js';
import { findAccountById } from '../identity/repositories/accounts.js';
import { appendIdentitySecurityEvent } from '../identity/repositories/security-events.js';
import { toIsoTimestamp } from '../lib/timestamps.js';
import {
  AppError,
  civicParticipationNotAuthorizedError,
  contributionMediaNotFoundError,
  mediaUploadFailedError,
  objectStorageNotAvailableError,
  signalNotFoundError,
} from '../errors/app-error.js';
import { evaluateCivicAccess } from '../membership/civic-access.js';
import {
  buildDiscussionMediaObjectKey,
  DISCUSSION_MEDIA_CONTENT_TYPES,
  DISCUSSION_MEDIA_UPLOAD_TTL_MS,
  discussionMediaKindForContentType,
  isAllowedDiscussionMediaContentType,
  matchesDiscussionMediaMagic,
  MAX_DISCUSSION_MEDIA_BYTES,
  maxBytesForDiscussionMediaKind,
} from '../membership/discussion-media-policy.js';
import {
  createDefaultLocalEligibilityResolver,
  type LocalParticipationEligibilityResolver,
} from '../membership/local-eligibility.js';
import { findEntitlementByAccountId } from '../membership/repositories/entitlements.js';
import type { ParticipationDenialReason } from '../membership/types.js';
import { ERROR_CODE } from '../schemas/error.js';
import {
  DiscussionContributionBodySchema,
  DiscussionContributionMediaParamsSchema,
  DiscussionSessionRouteResponses,
  SignalIdParamsSchema,
} from '../schemas/discussion-session.js';
import type { TownObjectStorageAdapter } from '../storage/object-storage-adapter.js';

export type DiscussionSessionRoutesOptions = {
  env: Env;
  now?: () => string;
  generateId?: () => string;
  localEligibilityResolver?: LocalParticipationEligibilityResolver;
  objectStorageAdapter?: TownObjectStorageAdapter | null;
};

const MIN_CONTRIBUTION_TEXT_LENGTH = 12;
const MAX_CONTRIBUTION_TEXT_LENGTH = 480;

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

function mediaProxyPath(signalId: string, contributionId: string): string {
  return `/v1/signals/${encodeURIComponent(signalId)}/discussion-session/contributions/${encodeURIComponent(contributionId)}/media`;
}

function toContributionDto(signalId: string, contribution: DiscussionContributionView) {
  return {
    id: contribution.id,
    authorDisplayName: contribution.authorDisplayName,
    text: contribution.text,
    intent: contribution.intent,
    createdAt: toIsoTimestamp(contribution.createdAt),
    media: contribution.media
      ? {
          kind: contribution.media.kind,
          contentType: contribution.media.contentType,
          byteSize: contribution.media.byteSize,
          url: mediaProxyPath(signalId, contribution.id),
        }
      : null,
  };
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
  throw validationError('Request body must be raw binary media bytes.');
}

export const discussionSessionRoutes: FastifyPluginCallbackTypebox<
  DiscussionSessionRoutesOptions
> = (app, options, done) => {
  const { env } = options;
  const now = () => (options.now ?? (() => new Date().toISOString()))();
  const generateId = options.generateId ?? (() => randomUUID());
  const objectStorageAdapter = options.objectStorageAdapter ?? null;
  const resolver: LocalParticipationEligibilityResolver =
    options.localEligibilityResolver ??
    createDefaultLocalEligibilityResolver({
      localEligibilityEnabled: env.LOCAL_ELIGIBILITY_ENABLED,
    });

  for (const contentType of DISCUSSION_MEDIA_CONTENT_TYPES) {
    app.addContentTypeParser(
      contentType,
      { parseAs: 'buffer', bodyLimit: MAX_DISCUSSION_MEDIA_BYTES },
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

  async function requireParticipantForSignal(input: {
    sessionAccountId: string;
    signalId: string;
    requestId: string;
  }): Promise<{
    signalId: string;
    actor: NonNullable<Awaited<ReturnType<typeof findActiveCivicActorByAccountId>>>;
  }> {
    const published = await findPublishedSignalById(app.database.db, input.signalId);
    if (!published) {
      throw signalNotFoundError();
    }

    const communityId = published.signal.communityId;
    const [account, entitlement, actor] = await Promise.all([
      findAccountById(app.database.db, input.sessionAccountId),
      findEntitlementByAccountId(app.database.db, input.sessionAccountId),
      findActiveCivicActorByAccountId(app.database.db, input.sessionAccountId),
    ]);

    const nowIso = now();
    const localEligibility = actor?.communityId
      ? await Promise.resolve(
          resolver({
            accountId: input.sessionAccountId,
            actorId: actor.id,
            communityId: actor.communityId,
            actor,
          }),
        )
      : 'not_verified';

    const access = evaluateCivicAccess({
      session: { accountId: input.sessionAccountId },
      account: account
        ? { id: account.id, status: account.status, isOwner: account.isOwner }
        : null,
      entitlement,
      actor,
      communityId,
      localEligibility,
      now: nowIso,
    });

    if (access.level !== 'participant' || !access.canParticipate) {
      const denialReason: ParticipationDenialReason = access.denialReason ?? 'inactive_account';
      await appendIdentitySecurityEvent(app.database.db, {
        id: generateId(),
        accountId: input.sessionAccountId,
        eventType: 'civic_participation_denied',
        occurredAt: nowIso,
        requestId: input.requestId,
        metadata: {
          denialReason,
        },
      });
      throw civicParticipationNotAuthorizedError();
    }

    if (!actor) {
      throw civicParticipationNotAuthorizedError();
    }

    return { signalId: published.signal.id, actor };
  }

  app.get(
    '/v1/signals/:signalId/discussion-session',
    {
      schema: {
        tags: ['Discussion'],
        summary: 'Read the civic discussion session for a published signal',
        description:
          'Returns the discussion session and ordered civic contributions for a published signal. Requires an active web or mobile session with participant civic access (access.canParticipate). Contributions are framed as movement toward a local solution (observation, proposal, or next step) — not chat, comments, or social replies. Attached photo/video media is exposed via authenticated proxy URLs when present. SetupGrant, RecoveryGrant, and Bearer are rejected. Never exposes actor or account identifiers.',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        params: SignalIdParamsSchema,
        response: DiscussionSessionRouteResponses.read,
      },
    },
    async (request, reply) => {
      if (!env.PASSKEY_AUTHENTICATION_ENABLED) {
        reply.callNotFound();
        return;
      }

      const session = await requireSession({
        headers: request.headers,
        cookies: request.cookies,
        mutative: false,
      });

      const { signalId } = await requireParticipantForSignal({
        sessionAccountId: session.accountId,
        signalId: request.params.signalId,
        requestId: request.id,
      });

      const nowIso = now();
      const discussionSession = await ensureDiscussionSessionForSignal(app.database.db, {
        signalId,
        id: generateId(),
        now: nowIso,
      });
      const contributions = await listDiscussionContributionsForSession(
        app.database.db,
        discussionSession.id,
      );

      return await reply.status(200).send({
        data: {
          session: {
            id: discussionSession.id,
            signalId: discussionSession.signalId,
            createdAt: toIsoTimestamp(discussionSession.createdAt),
          },
          contributions: contributions.map((contribution) =>
            toContributionDto(signalId, contribution),
          ),
        },
      });
    },
  );

  app.post(
    '/v1/signals/:signalId/discussion-session/media',
    {
      schema: {
        tags: ['Discussion'],
        summary: 'Upload media for a discussion contribution',
        description:
          'Uploads a photo or video into private object storage and returns a pending mediaUploadId. ' +
          'Attach that id when creating a contribution. Requires an active session with participant civic access. ' +
          'Body is raw binary bytes. Allowed Content-Type: image/jpeg, image/png, image/webp, video/mp4. ' +
          'SetupGrant, RecoveryGrant, and Bearer are rejected.',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        params: SignalIdParamsSchema,
        response: DiscussionSessionRouteResponses.mediaUpload,
      },
      bodyLimit: MAX_DISCUSSION_MEDIA_BYTES,
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

      const { signalId, actor } = await requireParticipantForSignal({
        sessionAccountId: session.accountId,
        signalId: request.params.signalId,
        requestId: request.id,
      });

      const contentTypeHeader = (singleHeader(request.headers['content-type']) ?? '')
        .split(';')[0]
        ?.trim()
        .toLowerCase();
      if (!contentTypeHeader) {
        throw validationError(
          'Content-Type must be image/jpeg, image/png, image/webp, or video/mp4.',
        );
      }
      if (!isAllowedDiscussionMediaContentType(contentTypeHeader)) {
        throw validationError(
          'Content-Type must be image/jpeg, image/png, image/webp, or video/mp4.',
        );
      }
      const contentType = contentTypeHeader;
      const kind = discussionMediaKindForContentType(contentType);
      if (!kind) {
        throw validationError('Unsupported media Content-Type.');
      }

      const bytes = parseUploadBody(request.body);
      if (bytes.byteLength === 0) {
        throw validationError('Media body must not be empty.');
      }
      if (!matchesDiscussionMediaMagic(contentType, bytes)) {
        throw validationError(
          'Media bytes do not match the declared Content-Type (magic-byte check failed).',
        );
      }
      const maxBytes = maxBytesForDiscussionMediaKind(kind);
      if (bytes.byteLength > maxBytes) {
        throw validationError(
          `Media exceeds maximum size of ${String(maxBytes)} bytes for ${kind}.`,
        );
      }

      const mediaUploadId = generateId();
      const objectKey = buildDiscussionMediaObjectKey({
        signalId,
        uploadId: mediaUploadId,
        kind,
        contentType,
      });

      const putResult = await objectStorageAdapter.putObject({
        key: objectKey,
        body: bytes,
        contentType,
      });
      if (!putResult.ok) {
        throw mediaUploadFailedError();
      }

      const nowIso = now();
      const expiresAt = new Date(Date.parse(nowIso) + DISCUSSION_MEDIA_UPLOAD_TTL_MS).toISOString();

      await insertPendingDiscussionMediaUpload(app.database.db, {
        id: mediaUploadId,
        signalId,
        accountId: session.accountId,
        actorId: actor.id,
        objectKey,
        contentType,
        kind,
        byteSize: bytes.byteLength,
        createdAt: nowIso,
        expiresAt,
      });

      // Etapa 5: structured, greppable-from-deployment-logs cost/traffic
      // telemetry -- see the matching comment in member-signals.ts.
      app.log.info(
        {
          mediaUpload: {
            route: 'discussion_contribution',
            kind,
            contentType,
            byteSize: bytes.byteLength,
          },
        },
        'discussion-contribution media uploaded',
      );

      return await reply.status(201).send({
        data: {
          mediaUploadId,
          kind,
          contentType,
          byteSize: bytes.byteLength,
          expiresAt: toIsoTimestamp(expiresAt),
        },
      });
    },
  );

  app.post(
    '/v1/signals/:signalId/discussion-session/contributions',
    {
      schema: {
        tags: ['Discussion'],
        summary: 'Publish a civic contribution to a signal discussion session',
        description:
          'Creates a civic contribution (observation, proposal, or next step) on the discussion session for a published signal. Requires an active web or mobile session with participant civic access (access.canParticipate). Optionally attaches a previously uploaded mediaUploadId owned by the same account for this signal. Not a chat or comment thread. Returns the session and the full ordered contribution list. SetupGrant, RecoveryGrant, and Bearer are rejected. Never exposes actor or account identifiers.',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        params: SignalIdParamsSchema,
        body: DiscussionContributionBodySchema,
        response: DiscussionSessionRouteResponses.contribute,
      },
    },
    async (request, reply) => {
      if (!env.PASSKEY_AUTHENTICATION_ENABLED) {
        reply.callNotFound();
        return;
      }

      const session = await requireSession({
        headers: request.headers,
        cookies: request.cookies,
        mutative: true,
      });

      const text = request.body.text.trim();
      if (
        text.length < MIN_CONTRIBUTION_TEXT_LENGTH ||
        text.length > MAX_CONTRIBUTION_TEXT_LENGTH
      ) {
        throw validationError();
      }

      const { signalId, actor } = await requireParticipantForSignal({
        sessionAccountId: session.accountId,
        signalId: request.params.signalId,
        requestId: request.id,
      });

      const mediaUploadId = request.body.mediaUploadId ?? null;
      if (mediaUploadId) {
        if (!objectStorageAdapter) {
          throw objectStorageNotAvailableError();
        }
        const pending = await findAttachableDiscussionMediaUpload(app.database.db, {
          mediaUploadId,
          signalId,
          accountId: session.accountId,
          now: now(),
        });
        if (!pending) {
          throw validationError(
            'mediaUploadId is not a pending upload owned by this account for this signal.',
          );
        }
      }

      const nowIso = now();
      const discussionSession = await ensureDiscussionSessionForSignal(app.database.db, {
        signalId,
        id: generateId(),
        now: nowIso,
      });

      await insertDiscussionContribution(app.database.db, {
        id: generateId(),
        sessionId: discussionSession.id,
        signalId,
        actorId: actor.id,
        text,
        intent: request.body.intent,
        mediaUploadId,
        createdAt: nowIso,
      });

      if (mediaUploadId) {
        await markDiscussionMediaUploadAttached(app.database.db, mediaUploadId);
      }

      const contributions = await listDiscussionContributionsForSession(
        app.database.db,
        discussionSession.id,
      );

      return await reply.status(201).send({
        data: {
          session: {
            id: discussionSession.id,
            signalId: discussionSession.signalId,
            createdAt: toIsoTimestamp(discussionSession.createdAt),
          },
          contributions: contributions.map((contribution) =>
            toContributionDto(signalId, contribution),
          ),
        },
      });
    },
  );

  app.get(
    '/v1/signals/:signalId/discussion-session/contributions/:contributionId/media',
    {
      schema: {
        tags: ['Discussion'],
        summary: 'Fetch attached media for a discussion contribution',
        description:
          'Streams the securely stored photo or video for a contribution from private object storage through the API. Requires an active session with participant civic access. Not a public bucket URL. Success responses are raw media bytes (no JSON envelope).',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        params: DiscussionContributionMediaParamsSchema,
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
        mutative: false,
      });

      const { signalId } = await requireParticipantForSignal({
        sessionAccountId: session.accountId,
        signalId: request.params.signalId,
        requestId: request.id,
      });

      const contribution = await findDiscussionContributionForSignal(
        app.database.db,
        signalId,
        request.params.contributionId,
      );
      if (!contribution?.mediaUploadId) {
        throw contributionMediaNotFoundError();
      }

      const upload = await findDiscussionMediaUploadById(
        app.database.db,
        contribution.mediaUploadId,
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
        .header('Cache-Control', 'private, max-age=300')
        .header('X-Content-Type-Options', 'nosniff');
      return reply.send(object.body);
    },
  );

  done();
};

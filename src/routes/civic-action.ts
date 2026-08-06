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
import {
  insertCivicActionUpdate,
  listCivicActionUpdatesForProcess,
} from '../db/repositories/civic-action.js';
import { closeVotingWindowIfElapsed, findCivicMandate } from '../db/repositories/civic-mandates.js';
import {
  findCivicProcessBySignalId,
  openVotingIfBallotPreparationElapsed,
} from '../db/repositories/civic-processes.js';
import { findCivicProposalById } from '../db/repositories/civic-proposals.js';
import { findActiveCivicActorByAccountId } from '../db/repositories/confirmations.js';
import { findPublishedSignalById } from '../db/repositories/signals.js';
import {
  AppError,
  civicParticipationNotAuthorizedError,
  signalNotFoundError,
} from '../errors/app-error.js';
import { findAccountById } from '../identity/repositories/accounts.js';
import { toIsoTimestamp } from '../lib/timestamps.js';
import { evaluateCivicAccess } from '../membership/civic-access.js';
import {
  createDefaultLocalEligibilityResolver,
  type LocalParticipationEligibilityResolver,
} from '../membership/local-eligibility.js';
import { findEntitlementByAccountId } from '../membership/repositories/entitlements.js';
import { CivicActionRouteResponses, CivicActionUpdateBodySchema } from '../schemas/civic-action.js';
import { ERROR_CODE } from '../schemas/error.js';
import { SignalIdParamsSchema } from '../schemas/signals.js';

export type CivicActionRoutesOptions = {
  env: Env;
  now?: () => string;
  generateId?: () => string;
  localEligibilityResolver?: LocalParticipationEligibilityResolver;
};

function sessionNotAuthorizedError(): AppError {
  return new AppError(401, 'SESSION_NOT_AUTHORIZED', 'Session is not authorized.');
}

function validationError(): AppError {
  return new AppError(400, ERROR_CODE.VALIDATION_ERROR, 'Request validation failed.');
}

function stageClosedError(): AppError {
  return new AppError(409, 'CIVIC_ACTION_STAGE_CLOSED', 'The action stage is not open.');
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function extractSessionTransport(input: {
  authorization: string | string[] | undefined;
  cookieName: string;
  cookies: Record<string, string | undefined> | undefined;
}): SessionTransportExtraction {
  const web = parseWebSessionCookie({ cookieName: input.cookieName, cookies: input.cookies });
  return web.ok ? web : parseSessionAuthorizationHeader(input.authorization);
}

function rejectNonSessionSchemes(authorization: string | string[] | undefined): void {
  const raw = Array.isArray(authorization) ? authorization[0] : authorization;
  if (!raw) return;
  const space = raw.indexOf(' ');
  if (space <= 0) return;
  const scheme = raw.slice(0, space);
  if (scheme === 'SetupGrant' || scheme === 'RecoveryGrant' || scheme === 'Bearer') {
    throw sessionNotAuthorizedError();
  }
}

export const civicActionRoutes: FastifyPluginCallbackTypebox<CivicActionRoutesOptions> = (
  app,
  options,
  done,
) => {
  const now = options.now ?? (() => new Date().toISOString());
  const generateId = options.generateId ?? (() => randomUUID());
  const resolver =
    options.localEligibilityResolver ??
    createDefaultLocalEligibilityResolver({
      localEligibilityEnabled: options.env.LOCAL_ELIGIBILITY_ENABLED,
    });

  async function resolveSession(
    request: {
      headers: {
        authorization?: string | string[] | undefined;
        origin?: string | string[] | undefined;
        'sec-fetch-site'?: string | string[] | undefined;
      };
      cookies?: Record<string, string | undefined>;
    },
    required: boolean,
    mutative: boolean,
  ) {
    if (!options.env.PASSKEY_AUTHENTICATION_ENABLED) {
      if (required) throw sessionNotAuthorizedError();
      return null;
    }
    rejectNonSessionSchemes(request.headers.authorization);
    const config = requirePasskeyManagementConfig(options.env);
    const extracted = extractSessionTransport({
      authorization: request.headers.authorization,
      cookieName: config.webSessionCookieName,
      cookies: request.cookies,
    });
    if (!extracted.ok) {
      if (required) throw sessionNotAuthorizedError();
      return null;
    }
    if (mutative && extracted.clientType === 'web') {
      const csrf = assertWebCookieCsrf({
        originHeader: singleHeader(request.headers.origin),
        secFetchSite: singleHeader(request.headers['sec-fetch-site']),
        allowedOrigins: config.allowedOrigins,
      });
      if (!csrf.ok) throw sessionNotAuthorizedError();
    }
    const session = await resolveActiveSession(
      app.database.db,
      { env: options.env, now },
      { clientType: extracted.clientType, token: extracted.token },
    );
    if (!session && required) throw sessionNotAuthorizedError();
    return session;
  }

  async function participantActor(
    accountId: string | null,
    communityId: string,
  ): Promise<Awaited<ReturnType<typeof findActiveCivicActorByAccountId>> | null> {
    if (!accountId) return null;
    const [account, entitlement, actor] = await Promise.all([
      findAccountById(app.database.db, accountId),
      findEntitlementByAccountId(app.database.db, accountId),
      findActiveCivicActorByAccountId(app.database.db, accountId),
    ]);
    const localEligibility = actor?.communityId
      ? await Promise.resolve(
          resolver({ accountId, actorId: actor.id, communityId: actor.communityId, actor }),
        )
      : 'not_verified';
    const access = evaluateCivicAccess({
      session: { accountId },
      account: account
        ? { id: account.id, status: account.status, isOwner: account.isOwner }
        : null,
      entitlement,
      actor,
      communityId,
      localEligibility,
      now: now(),
    });
    return access.level === 'participant' && access.canParticipate && actor ? actor : null;
  }

  async function visibleProcess(signalId: string) {
    const published = await findPublishedSignalById(app.database.db, signalId);
    if (!published) throw signalNotFoundError();
    const initialProcess = await findCivicProcessBySignalId(app.database.db, published.signal.id);
    if (initialProcess?.communityId !== published.signal.communityId) {
      throw new Error('Visible signal is missing its canonical civic process');
    }
    if (initialProcess.currentStage === 'ballot_preparation') {
      await openVotingIfBallotPreparationElapsed(app.database.db, {
        processId: initialProcess.id,
        now: now(),
      });
    }
    if (initialProcess.currentStage === 'voting') {
      await closeVotingWindowIfElapsed(app.database.db, {
        processId: initialProcess.id,
        now: now(),
      });
    }
    const process = await findCivicProcessBySignalId(app.database.db, published.signal.id);
    if (!process) {
      throw new Error('Civic process disappeared after lazy close check');
    }
    return { published, process };
  }

  app.get(
    '/v1/signals/:signalId/civic-process/action',
    {
      schema: {
        tags: ['Civic Process'],
        summary: 'Read the action status log for a decided civic mandate',
        description:
          'Public winning proposal and an open, structured status log for a visible signal once its mandate is decided. Any active community actor may post a status update while the process is in action. Never invents a completion percentage or threshold.',
        params: SignalIdParamsSchema,
        response: CivicActionRouteResponses.read,
      },
    },
    async (request, reply) => {
      const { published, process } = await visibleProcess(request.params.signalId);
      const session = await resolveSession(request, false, false);
      const actor = await participantActor(
        session?.accountId ?? null,
        published.signal.communityId,
      );
      const hasReachedAction =
        process.currentStage === 'action' ||
        process.currentStage === 'verification' ||
        process.currentStage === 'archived';
      const mandate =
        process.currentStage === 'mandate' || hasReachedAction
          ? await findCivicMandate(app.database.db, process.id)
          : null;
      const [winnerProposal, updates] = await Promise.all([
        mandate?.proposalId ? findCivicProposalById(app.database.db, mandate.proposalId) : null,
        hasReachedAction
          ? listCivicActionUpdatesForProcess(app.database.db, process.id)
          : Promise.resolve([]),
      ]);
      return await reply.status(200).send({
        data: {
          processId: process.id,
          currentStage:
            process.currentStage === 'mandate' ||
            process.currentStage === 'action' ||
            process.currentStage === 'verification' ||
            process.currentStage === 'archived'
              ? process.currentStage
              : 'mandate',
          winner: winnerProposal
            ? {
                proposalId: winnerProposal.id,
                authorDisplayName: winnerProposal.authorDisplayName,
                title: winnerProposal.title,
                body: winnerProposal.body,
                voteCount: mandate?.voteCount ?? 0,
              }
            : null,
          canPost: process.currentStage === 'action' && actor !== null,
          updates: updates.map((update) => ({
            id: update.id,
            authorDisplayName: update.authorDisplayName,
            text: update.text,
            createdAt: toIsoTimestamp(update.createdAt),
            isMine: actor?.id === update.authorActorId,
          })),
        },
      });
    },
  );

  app.post(
    '/v1/signals/:signalId/civic-process/action/updates',
    {
      schema: {
        tags: ['Civic Process'],
        summary: 'Post a status update on a decided civic mandate',
        description:
          'Creates a short, structured status update while the canonical process is in action. Does not transition the process; verification of the action is a later stage.',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        params: SignalIdParamsSchema,
        body: CivicActionUpdateBodySchema,
        response: CivicActionRouteResponses.create,
      },
    },
    async (request, reply) => {
      const { published, process } = await visibleProcess(request.params.signalId);
      if (process.currentStage !== 'action') throw stageClosedError();
      const session = await resolveSession(request, true, true);
      if (!session) throw sessionNotAuthorizedError();
      const actor = await participantActor(session.accountId, published.signal.communityId);
      if (!actor) throw civicParticipationNotAuthorizedError();
      const text = request.body.text.trim();
      if (text.length < 12 || text.length > 480) throw validationError();
      const updateId = generateId();
      const createdAt = now();
      try {
        await insertCivicActionUpdate(app.database.db, {
          id: updateId,
          processId: process.id,
          actorId: actor.id,
          text,
          createdAt,
        });
      } catch (error: unknown) {
        if (error instanceof Error && error.message.includes('stage is closed')) {
          throw stageClosedError();
        }
        throw error;
      }
      return await reply.status(201).send({
        data: {
          id: updateId,
          authorDisplayName: actor.displayLabel,
          text,
          createdAt: toIsoTimestamp(createdAt),
          isMine: true,
        },
      });
    },
  );

  done();
};

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
  insertCivicDeliberationContribution,
  listCivicDeliberationContributionsForProcess,
} from '../db/repositories/civic-deliberation.js';
import { findCivicProcessBySignalId } from '../db/repositories/civic-processes.js';
import { findCivicProposalById, listCivicProposals } from '../db/repositories/civic-proposals.js';
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
import {
  CivicDeliberationContributionBodySchema,
  CivicDeliberationRouteResponses,
  SignalProposalIdParamsSchema,
} from '../schemas/civic-deliberation.js';
import { ERROR_CODE } from '../schemas/error.js';
import { SignalIdParamsSchema } from '../schemas/signals.js';

export type CivicDeliberationRoutesOptions = {
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
  return new AppError(
    409,
    'CIVIC_DELIBERATION_STAGE_CLOSED',
    'The deliberation stage is not open.',
  );
}

function proposalNotFoundError(): AppError {
  return new AppError(404, 'CIVIC_PROPOSAL_NOT_FOUND', 'The requested proposal was not found.');
}

function invalidReplyTargetError(): AppError {
  return new AppError(
    400,
    'CIVIC_DELIBERATION_INVALID_REPLY_TARGET',
    'The contribution being replied to does not belong to this proposal.',
  );
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

export const civicDeliberationRoutes: FastifyPluginCallbackTypebox<
  CivicDeliberationRoutesOptions
> = (app, options, done) => {
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
    const process = await findCivicProcessBySignalId(app.database.db, published.signal.id);
    if (process?.communityId !== published.signal.communityId) {
      throw new Error('Visible signal is missing its canonical civic process');
    }
    return { published, process };
  }

  app.get(
    '/v1/signals/:signalId/civic-process/deliberation',
    {
      schema: {
        tags: ['Civic Process'],
        summary: 'Read civic deliberation on the proposals for a civic process',
        description:
          'Public proposals for a visible signal with their structured deliberation contributions (observation, proposal, next_step). Optional session state derives only canContribute and isMine. Never exposes account or actor identifiers.',
        params: SignalIdParamsSchema,
        response: CivicDeliberationRouteResponses.read,
      },
    },
    async (request, reply) => {
      const { published, process } = await visibleProcess(request.params.signalId);
      const session = await resolveSession(request, false, false);
      const actor = await participantActor(
        session?.accountId ?? null,
        published.signal.communityId,
      );
      const [proposals, contributions] = await Promise.all([
        listCivicProposals(app.database.db, process.id),
        listCivicDeliberationContributionsForProcess(app.database.db, process.id),
      ]);
      const contributionsByProposal = new Map<string, typeof contributions>();
      for (const contribution of contributions) {
        const bucket = contributionsByProposal.get(contribution.proposalId);
        if (bucket) {
          bucket.push(contribution);
        } else {
          contributionsByProposal.set(contribution.proposalId, [contribution]);
        }
      }
      return await reply.status(200).send({
        data: {
          processId: process.id,
          currentStage:
            process.currentStage === 'proposals' ||
            process.currentStage === 'deliberation' ||
            process.currentStage === 'ballot_preparation' ||
            process.currentStage === 'voting' ||
            process.currentStage === 'mandate' ||
            process.currentStage === 'action' ||
            process.currentStage === 'verification' ||
            process.currentStage === 'archived'
              ? process.currentStage
              : 'proposals',
          canContribute: process.currentStage === 'deliberation' && actor !== null,
          proposals: proposals.map((proposal) => ({
            id: proposal.id,
            authorDisplayName: proposal.authorDisplayName,
            title: proposal.title,
            body: proposal.body,
            createdAt: toIsoTimestamp(proposal.createdAt),
            isMine: actor?.id === proposal.authorActorId,
            contributions: (contributionsByProposal.get(proposal.id) ?? []).map((contribution) => ({
              id: contribution.id,
              authorDisplayName: contribution.authorDisplayName,
              intent: contribution.intent,
              text: contribution.text,
              replyToContributionId: contribution.replyToContributionId,
              createdAt: toIsoTimestamp(contribution.createdAt),
              isMine: actor?.id === contribution.authorActorId,
            })),
          })),
        },
      });
    },
  );

  app.post(
    '/v1/signals/:signalId/civic-process/deliberation/proposals/:proposalId/contributions',
    {
      schema: {
        tags: ['Civic Process'],
        summary: 'Publish a deliberation contribution on one proposal',
        description:
          'Creates a structured contribution (observation, proposal, or next step) on one proposal while the canonical process is in deliberation. Session and CSRF rules are unchanged. Does not transition the process.',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        params: SignalProposalIdParamsSchema,
        body: CivicDeliberationContributionBodySchema,
        response: CivicDeliberationRouteResponses.create,
      },
    },
    async (request, reply) => {
      const { published, process } = await visibleProcess(request.params.signalId);
      if (process.currentStage !== 'deliberation') throw stageClosedError();
      const proposal = await findCivicProposalById(app.database.db, request.params.proposalId);
      if (proposal?.processId !== process.id) throw proposalNotFoundError();
      const session = await resolveSession(request, true, true);
      if (!session) throw sessionNotAuthorizedError();
      const actor = await participantActor(session.accountId, published.signal.communityId);
      if (!actor) throw civicParticipationNotAuthorizedError();
      const text = request.body.text.trim();
      if (text.length < 12 || text.length > 480) throw validationError();
      const replyToContributionId = request.body.replyToContributionId ?? null;
      if (replyToContributionId) {
        const contributions = await listCivicDeliberationContributionsForProcess(
          app.database.db,
          process.id,
        );
        const replyTarget = contributions.find((c) => c.id === replyToContributionId);
        if (replyTarget?.proposalId !== proposal.id) {
          throw invalidReplyTargetError();
        }
      }
      const contributionId = generateId();
      const createdAt = now();
      try {
        await insertCivicDeliberationContribution(app.database.db, {
          id: contributionId,
          processId: process.id,
          proposalId: proposal.id,
          actorId: actor.id,
          intent: request.body.intent,
          text,
          replyToContributionId,
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
          proposalId: proposal.id,
          contribution: {
            id: contributionId,
            authorDisplayName: actor.displayLabel,
            intent: request.body.intent,
            text,
            replyToContributionId,
            createdAt: toIsoTimestamp(createdAt),
            isMine: true,
          },
        },
      });
    },
  );

  done();
};

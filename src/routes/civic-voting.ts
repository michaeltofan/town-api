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
  findCivicVoteByProcessAndActor,
  insertCivicVote,
  listCivicVoteTallyForProcess,
} from '../db/repositories/civic-votes.js';
import { closeVotingWindowIfElapsed } from '../db/repositories/civic-mandates.js';
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
import { CivicVoteBodySchema, CivicVotingRouteResponses } from '../schemas/civic-voting.js';
import { SignalIdParamsSchema } from '../schemas/signals.js';

export type CivicVotingRoutesOptions = {
  env: Env;
  now?: () => string;
  generateId?: () => string;
  localEligibilityResolver?: LocalParticipationEligibilityResolver;
};

function sessionNotAuthorizedError(): AppError {
  return new AppError(401, 'SESSION_NOT_AUTHORIZED', 'Session is not authorized.');
}

function stageClosedError(): AppError {
  return new AppError(409, 'CIVIC_VOTING_STAGE_CLOSED', 'The voting stage is not open.');
}

function alreadyVotedError(): AppError {
  return new AppError(409, 'CIVIC_VOTE_ALREADY_CAST', 'This member has already voted.');
}

function proposalNotFoundError(): AppError {
  return new AppError(404, 'CIVIC_PROPOSAL_NOT_FOUND', 'The requested proposal was not found.');
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

export const civicVotingRoutes: FastifyPluginCallbackTypebox<CivicVotingRoutesOptions> = (
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
    '/v1/signals/:signalId/civic-process/voting',
    {
      schema: {
        tags: ['Civic Process'],
        summary: 'Read the civic vote for a process and its per-option tally',
        description:
          'Public vote options for a visible signal (the five finalized ballot proposals) with aggregate vote counts. Optional session state derives only canVote, hasVoted, and myChoice. Never exposes account or actor identifiers, and never who voted for what.',
        params: SignalIdParamsSchema,
        response: CivicVotingRouteResponses.read,
      },
    },
    async (request, reply) => {
      const { published, process } = await visibleProcess(request.params.signalId);
      const session = await resolveSession(request, false, false);
      const actor = await participantActor(
        session?.accountId ?? null,
        published.signal.communityId,
      );
      const [proposals, tally] = await Promise.all([
        listCivicProposals(app.database.db, process.id),
        listCivicVoteTallyForProcess(app.database.db, process.id),
      ]);
      const tallyByProposal = new Map(tally.map((row) => [row.proposalId, row.voteCount]));
      const ownVote = actor
        ? await findCivicVoteByProcessAndActor(app.database.db, {
            processId: process.id,
            actorId: actor.id,
          })
        : null;
      const totalVotes = tally.reduce((sum, row) => sum + row.voteCount, 0);
      return await reply.status(200).send({
        data: {
          processId: process.id,
          currentStage:
            process.currentStage === 'ballot_preparation' ||
            process.currentStage === 'voting' ||
            process.currentStage === 'mandate' ||
            process.currentStage === 'action'
              ? process.currentStage
              : 'ballot_preparation',
          canVote: process.currentStage === 'voting' && actor !== null && ownVote === null,
          hasVoted: ownVote !== null,
          myChoice: ownVote?.proposalId ?? null,
          totalVotes,
          options: proposals.map((proposal) => ({
            proposalId: proposal.id,
            authorDisplayName: proposal.authorDisplayName,
            title: proposal.title,
            body: proposal.body,
            voteCount: tallyByProposal.get(proposal.id) ?? 0,
          })),
        },
      });
    },
  );

  app.post(
    '/v1/signals/:signalId/civic-process/voting/vote',
    {
      schema: {
        tags: ['Civic Process'],
        summary: 'Cast one vote for one ballot option',
        description:
          'Records one vote for one proposal while the canonical process is in voting. One vote per eligible civic actor; votes cannot be changed once cast. This is not yet a secret ballot: the vote is linked to the actor internally for eligibility and one-person-one-vote enforcement, and TOWN does not present it as anonymous.',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        params: SignalIdParamsSchema,
        body: CivicVoteBodySchema,
        response: CivicVotingRouteResponses.create,
      },
    },
    async (request, reply) => {
      const { published, process } = await visibleProcess(request.params.signalId);
      if (process.currentStage !== 'voting') throw stageClosedError();
      const proposal = await findCivicProposalById(app.database.db, request.body.proposalId);
      if (proposal?.processId !== process.id) throw proposalNotFoundError();
      const session = await resolveSession(request, true, true);
      if (!session) throw sessionNotAuthorizedError();
      const actor = await participantActor(session.accountId, published.signal.communityId);
      if (!actor) throw civicParticipationNotAuthorizedError();
      const existing = await findCivicVoteByProcessAndActor(app.database.db, {
        processId: process.id,
        actorId: actor.id,
      });
      if (existing) throw alreadyVotedError();
      const voteId = generateId();
      const castAt = now();
      try {
        await insertCivicVote(app.database.db, {
          id: voteId,
          processId: process.id,
          proposalId: proposal.id,
          actorId: actor.id,
          castAt,
        });
      } catch (error: unknown) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          (error as { code?: unknown }).code === '23505'
        ) {
          throw alreadyVotedError();
        }
        if (error instanceof Error && error.message.includes('stage is closed')) {
          throw stageClosedError();
        }
        throw error;
      }
      return await reply.status(201).send({
        data: {
          proposalId: proposal.id,
          castAt: toIsoTimestamp(castAt),
        },
      });
    },
  );

  done();
};

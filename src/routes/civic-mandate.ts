import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import type { Env } from '../config/env.js';
import { requirePasskeyManagementConfig } from '../ceremony/passkey-management/config.js';
import { assertWebCookieCsrf } from '../ceremony/passkey-authentication/csrf.js';
import {
  parseSessionAuthorizationHeader,
  parseWebSessionCookie,
  type SessionTransportExtraction,
} from '../ceremony/passkey-authentication/session-transport.js';
import { resolveActiveSession } from '../ceremony/passkey-authentication/service.js';
import { isCivicBallotEligibleActor } from '../db/repositories/civic-ballot.js';
import {
  findCivicMandateContestationByProcessAndActor,
  hasPendingCivicMandateContestation,
  insertCivicMandateContestation,
} from '../db/repositories/civic-contestations.js';
import { listMinorityPositionContributions } from '../db/repositories/civic-deliberation.js';
import { closeVotingWindowIfElapsed, findCivicMandate } from '../db/repositories/civic-mandates.js';
import {
  findCivicProcessBySignalId,
  openVotingIfBallotPreparationElapsed,
  quorumFailedForBallotCycle,
} from '../db/repositories/civic-processes.js';
import { countCivicVotesForProcess } from '../db/repositories/civic-votes.js';
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
import {
  CivicMandateContestBodySchema,
  CivicMandateRouteResponses,
} from '../schemas/civic-mandate.js';
import { SignalIdParamsSchema } from '../schemas/signals.js';

const CONTESTATION_WINDOW_HOURS = 72;

export type CivicMandateRoutesOptions = {
  env: Env;
  now?: () => string;
  localEligibilityResolver?: LocalParticipationEligibilityResolver;
};

function sessionNotAuthorizedError(): AppError {
  return new AppError(401, 'SESSION_NOT_AUTHORIZED', 'Session is not authorized.');
}

function mandateNotDecidedError(): AppError {
  return new AppError(
    409,
    'CIVIC_MANDATE_NOT_DECIDED',
    'A mandate contestation requires a decided mandate.',
  );
}

function contestationWindowClosedError(): AppError {
  return new AppError(
    409,
    'CIVIC_CONTESTATION_WINDOW_CLOSED',
    'The 72-hour contestation window has closed.',
  );
}

function notEligibleForContestationError(): AppError {
  return new AppError(
    403,
    'CIVIC_CONTESTATION_NOT_ELIGIBLE',
    'This member was not on the eligible-voter list for the decisive ballot.',
  );
}

function alreadyContestedError(): AppError {
  return new AppError(
    409,
    'CIVIC_CONTESTATION_ALREADY_FILED',
    'This member has already filed a contestation for this mandate.',
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

export const civicMandateRoutes: FastifyPluginCallbackTypebox<CivicMandateRoutesOptions> = (
  app,
  options,
  done,
) => {
  const now = options.now ?? (() => new Date().toISOString());
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
    '/v1/signals/:signalId/civic-process/mandate',
    {
      schema: {
        tags: ['Civic Process'],
        summary: 'Read the civic mandate for a process once voting has closed',
        description:
          'Public final result for a visible signal. Voting closes lazily the moment any request observes an elapsed voting window (no scheduled job). A perfect tie among the top vote counts is reported as contested with no winner — no tie-break rule is invented. Never exposes who voted for what. Also surfaces any minority_position deliberation contributions as a permanent part of the record (§11), and reports whether a procedural contestation (§10) is pending — an eligible actor may file one within 72 hours of voting closing.',
        params: SignalIdParamsSchema,
        response: CivicMandateRouteResponses.read,
      },
    },
    async (request, reply) => {
      const { published, process } = await visibleProcess(request.params.signalId);

      const isDecided =
        process.currentStage === 'mandate' ||
        process.currentStage === 'action' ||
        process.currentStage === 'verification' ||
        process.currentStage === 'archived';
      const mandate = isDecided ? await findCivicMandate(app.database.db, process.id) : null;
      const winnerProposal = mandate?.proposalId
        ? await findCivicProposalById(app.database.db, mandate.proposalId)
        : null;

      // A quorum failure (§9) returns the process to deliberation and
      // increments ballot_cycle — check whether the immediately prior
      // cycle ended that way, so a caller who missed the transition still
      // learns why there is no mandate yet, honestly, rather than seeing an
      // indistinguishable "still voting."
      const quorumFailed =
        !isDecided &&
        process.currentStage === 'deliberation' &&
        process.ballotCycle > 1 &&
        (await quorumFailedForBallotCycle(app.database.db, {
          processId: process.id,
          ballotCycle: process.ballotCycle - 1,
        }));
      const quorumFailedVoteCount = quorumFailed
        ? await countCivicVotesForProcess(app.database.db, {
            processId: process.id,
            ballotCycle: process.ballotCycle - 1,
          })
        : 0;

      const minorityPositions = isDecided
        ? await listMinorityPositionContributions(app.database.db, process.id)
        : [];

      const contestationWindowClosesAt =
        mandate && process.votingClosesAt
          ? new Date(
              new Date(process.votingClosesAt).getTime() +
                CONTESTATION_WINDOW_HOURS * 60 * 60 * 1000,
            ).toISOString()
          : null;
      const contestationPending = mandate
        ? await hasPendingCivicMandateContestation(app.database.db, process.id)
        : false;

      const session = await resolveSession(request, false, false);
      const actor = await participantActor(
        session?.accountId ?? null,
        published.signal.communityId,
      );
      const myContestation =
        mandate && actor
          ? await findCivicMandateContestationByProcessAndActor(app.database.db, {
              processId: process.id,
              actorId: actor.id,
            })
          : null;
      const canContest =
        mandate !== null &&
        actor !== null &&
        myContestation === null &&
        contestationWindowClosesAt !== null &&
        now() <= contestationWindowClosesAt &&
        (await isCivicBallotEligibleActor(app.database.db, {
          processId: process.id,
          actorId: actor.id,
          ballotCycle: process.ballotCycle,
        }));

      return await reply.status(200).send({
        data: {
          processId: process.id,
          currentStage:
            process.currentStage === 'deliberation' ||
            process.currentStage === 'voting' ||
            process.currentStage === 'mandate' ||
            process.currentStage === 'action' ||
            process.currentStage === 'verification' ||
            process.currentStage === 'archived'
              ? process.currentStage
              : 'voting',
          decided: isDecided,
          contested: mandate !== null && mandate.proposalId === null,
          quorumFailed,
          winner: winnerProposal
            ? {
                proposalId: winnerProposal.id,
                authorDisplayName: winnerProposal.authorDisplayName,
                title: winnerProposal.title,
                body: winnerProposal.body,
                voteCount: mandate?.voteCount ?? 0,
                targetInstitution: winnerProposal.targetInstitution,
                objective: winnerProposal.expectedOutcome,
                indicativeDeadline: winnerProposal.indicativeDeadline,
              }
            : null,
          totalVotes: quorumFailed ? quorumFailedVoteCount : (mandate?.totalVotes ?? 0),
          votingClosesAt: process.votingClosesAt ? toIsoTimestamp(process.votingClosesAt) : null,
          decidedAt: mandate ? toIsoTimestamp(mandate.decidedAt) : null,
          minorityPositions: minorityPositions.map((contribution) => ({
            id: contribution.id,
            authorDisplayName: contribution.authorDisplayName,
            proposalId: contribution.proposalId,
            text: contribution.text,
            createdAt: toIsoTimestamp(contribution.createdAt),
          })),
          contestationWindowClosesAt,
          contestationPending,
          myContestation: myContestation
            ? {
                reasonKey: myContestation.reasonKey,
                status: myContestation.status,
                filedAt: toIsoTimestamp(myContestation.filedAt),
              }
            : null,
          canContest,
        },
      });
    },
  );

  app.post(
    '/v1/signals/:signalId/civic-process/mandate/contest',
    {
      schema: {
        tags: ['Civic Process'],
        summary: 'File a procedural contestation against a decided mandate',
        description:
          'Any actor who was eligible for the decisive ballot may file one procedural contestation, within 72 hours of voting_closes_at, citing a fixed reason code (§10). Unlike a vote, a contestation is filed openly under the filer\'s own identity — there is no secrecy requirement here. Filing moves the process to a verification_pending sub-flag pending operator review; that review is not implemented yet, so every contestation reports status "pending" for now.',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        params: SignalIdParamsSchema,
        body: CivicMandateContestBodySchema,
        response: CivicMandateRouteResponses.contest,
      },
    },
    async (request, reply) => {
      const { published, process } = await visibleProcess(request.params.signalId);
      const mandate = await findCivicMandate(app.database.db, process.id);
      if (!mandate) throw mandateNotDecidedError();
      if (
        !process.votingClosesAt ||
        now() >
          new Date(
            new Date(process.votingClosesAt).getTime() + CONTESTATION_WINDOW_HOURS * 60 * 60 * 1000,
          ).toISOString()
      ) {
        throw contestationWindowClosedError();
      }

      const session = await resolveSession(request, true, true);
      if (!session) throw sessionNotAuthorizedError();
      const actor = await participantActor(session.accountId, published.signal.communityId);
      if (!actor) throw civicParticipationNotAuthorizedError();

      const eligible = await isCivicBallotEligibleActor(app.database.db, {
        processId: process.id,
        actorId: actor.id,
        ballotCycle: process.ballotCycle,
      });
      if (!eligible) throw notEligibleForContestationError();

      const existing = await findCivicMandateContestationByProcessAndActor(app.database.db, {
        processId: process.id,
        actorId: actor.id,
      });
      if (existing) throw alreadyContestedError();

      const filedAt = now();
      try {
        await insertCivicMandateContestation(app.database.db, {
          processId: process.id,
          filerActorId: actor.id,
          reasonKey: request.body.reasonKey,
          elaboration: request.body.elaboration ?? null,
          filedAt,
        });
      } catch (error: unknown) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          (error as { code?: unknown }).code === '23505'
        ) {
          throw alreadyContestedError();
        }
        if (error instanceof Error && error.message.includes('window has closed')) {
          throw contestationWindowClosedError();
        }
        if (error instanceof Error && error.message.includes('was not eligible')) {
          throw notEligibleForContestationError();
        }
        if (error instanceof Error && error.message.includes('requires a decided mandate')) {
          throw mandateNotDecidedError();
        }
        throw error;
      }

      return await reply.status(201).send({
        data: {
          reasonKey: request.body.reasonKey,
          status: 'pending',
          filedAt: toIsoTimestamp(filedAt),
        },
      });
    },
  );

  done();
};

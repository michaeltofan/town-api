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
  countConfirmationsForSignal,
  findActiveCivicActorByAccountId,
  findConfirmationByActorAndSignal,
} from '../db/repositories/confirmations.js';
import { countCivicBallotEligibleActors } from '../db/repositories/civic-ballot.js';
import { countDistinctCivicDeliberationParticipants } from '../db/repositories/civic-deliberation.js';
import { markCivicProcessViewed } from '../db/repositories/civic-inbox.js';
import { closeVotingWindowIfElapsed } from '../db/repositories/civic-mandates.js';
import {
  countCivicProposalsForProcess,
  listCivicProposals,
} from '../db/repositories/civic-proposals.js';
import { countCivicVotesForProcess } from '../db/repositories/civic-votes.js';
import {
  CIVIC_BALLOT_QUESTION,
  CIVIC_BALLOT_QUORUM,
  CIVIC_CONFIRMATION_THRESHOLD,
  CIVIC_DELIBERATION_THRESHOLD,
  CIVIC_PROPOSAL_THRESHOLD,
  findCivicProcessBySignalId,
  listPublicCivicProcessEvents,
  openVotingIfBallotPreparationElapsed,
  provisionMissingCivicProcess,
} from '../db/repositories/civic-processes.js';
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
  CivicProcessResponseSchema,
  CivicProcessViewedResponseSchema,
} from '../schemas/civic-process.js';
import { DomainErrorResponseSchema } from '../schemas/error.js';
import { SignalIdParamsSchema } from '../schemas/signals.js';

export type CivicProcessRoutesOptions = {
  env: Env;
  now?: () => string;
  generateId?: () => string;
  localEligibilityResolver?: LocalParticipationEligibilityResolver;
};

function sessionNotAuthorizedError(): AppError {
  return new AppError(401, 'SESSION_NOT_AUTHORIZED', 'Session is not authorized.');
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

export const civicProcessRoutes: FastifyPluginCallbackTypebox<CivicProcessRoutesOptions> = (
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

  async function resolveOptionalSessionAccountId(request: {
    headers: { authorization?: string | string[] | undefined };
    cookies?: Record<string, string | undefined>;
  }): Promise<string | null> {
    if (!options.env.PASSKEY_AUTHENTICATION_ENABLED) {
      return null;
    }
    const config = requirePasskeyManagementConfig(options.env);
    const web = parseWebSessionCookie({
      cookieName: config.webSessionCookieName,
      cookies: request.cookies,
    });
    const extracted = web.ok ? web : parseSessionAuthorizationHeader(request.headers.authorization);
    if (!extracted.ok) {
      return null;
    }
    const session = await resolveActiveSession(
      app.database.db,
      { env: options.env, now },
      { clientType: extracted.clientType, token: extracted.token },
    );
    return session?.accountId ?? null;
  }

  const generateId = options.generateId ?? (() => randomUUID());

  async function resolveRequiredSession(request: {
    headers: {
      authorization?: string | string[] | undefined;
      origin?: string | string[] | undefined;
      'sec-fetch-site'?: string | string[] | undefined;
    };
    cookies?: Record<string, string | undefined>;
  }) {
    rejectNonSessionSchemes(request.headers.authorization);
    const config = requirePasskeyManagementConfig(options.env);
    const extracted = extractSessionTransport({
      authorization: request.headers.authorization,
      cookieName: config.webSessionCookieName,
      cookies: request.cookies,
    });
    if (!extracted.ok) throw sessionNotAuthorizedError();
    if (extracted.clientType === 'web') {
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
    if (!session) throw sessionNotAuthorizedError();
    return session;
  }

  app.get(
    '/v1/signals/:signalId/civic-process',
    {
      schema: {
        tags: ['Civic Process'],
        summary: 'Read the canonical civic process for a visible signal',
        description:
          "Public, bounded civic-process state. An optional active session derives only the caller's own confirmation capability; visitors and read-only accounts receive false without private denial reasons.",
        params: SignalIdParamsSchema,
        response: {
          200: CivicProcessResponseSchema,
          400: DomainErrorResponseSchema,
          404: DomainErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const published = await findPublishedSignalById(app.database.db, request.params.signalId);
      if (!published) {
        throw signalNotFoundError();
      }

      let initialProcess = await findCivicProcessBySignalId(app.database.db, published.signal.id);
      if (initialProcess?.communityId !== published.signal.communityId) {
        // A published signal must always have a canonical civic process; the
        // AFTER INSERT trigger normally guarantees this, but a signal upserted
        // via ON CONFLICT DO UPDATE (e.g. re-seeding foundation content) does
        // not re-fire that trigger, so backfill it here instead of failing.
        await provisionMissingCivicProcess(app.database.db, {
          processId: generateId(),
          eventId: generateId(),
          signalId: published.signal.id,
          communityId: published.signal.communityId,
          createdAt: published.signal.createdAt,
        });
        initialProcess = await findCivicProcessBySignalId(app.database.db, published.signal.id);
        if (initialProcess?.communityId !== published.signal.communityId) {
          throw new Error('Visible signal is missing its canonical civic process');
        }
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

      const [
        confirmationCount,
        proposalCount,
        deliberationParticipantCount,
        voteCount,
        timeline,
        accountId,
        ballotPreviewProposals,
        eligibleVoterCount,
      ] = await Promise.all([
        countConfirmationsForSignal(app.database.db, published.signal.id),
        countCivicProposalsForProcess(app.database.db, process.id),
        countDistinctCivicDeliberationParticipants(app.database.db, process.id),
        countCivicVotesForProcess(app.database.db, {
          processId: process.id,
          ballotCycle: process.ballotCycle,
        }),
        listPublicCivicProcessEvents(app.database.db, process.id),
        resolveOptionalSessionAccountId(request),
        process.currentStage === 'ballot_preparation'
          ? listCivicProposals(app.database.db, process.id)
          : Promise.resolve([]),
        process.currentStage === 'ballot_preparation'
          ? countCivicBallotEligibleActors(app.database.db, process.id)
          : Promise.resolve(0),
      ]);

      let hasConfirmed = false;
      let canConfirm = false;
      if (accountId) {
        const [account, entitlement, actor] = await Promise.all([
          findAccountById(app.database.db, accountId),
          findEntitlementByAccountId(app.database.db, accountId),
          findActiveCivicActorByAccountId(app.database.db, accountId),
        ]);
        const localEligibility = actor?.communityId
          ? await Promise.resolve(
              resolver({
                accountId,
                actorId: actor.id,
                communityId: actor.communityId,
                actor,
              }),
            )
          : 'not_verified';
        const access = evaluateCivicAccess({
          session: { accountId },
          account: account
            ? { id: account.id, status: account.status, isOwner: account.isOwner }
            : null,
          entitlement,
          actor,
          communityId: published.signal.communityId,
          localEligibility,
          now: now(),
        });
        if (access.level === 'participant' && access.canParticipate && actor) {
          const confirmation = await findConfirmationByActorAndSignal(
            app.database.db,
            actor.id,
            published.signal.id,
          );
          hasConfirmed = confirmation !== null;
          canConfirm = process.currentStage === 'confirmation' && confirmation === null;
        }
      }

      return await reply.status(200).send({
        data: {
          id: process.id,
          signalId: process.signalId,
          communitySlug: published.community.slug,
          currentStage: process.currentStage,
          stageLabelKey:
            process.currentStage === 'confirmation'
              ? 'civic_process.stage.confirmation'
              : process.currentStage === 'proposals'
                ? 'civic_process.stage.proposals'
                : process.currentStage === 'deliberation'
                  ? 'civic_process.stage.deliberation'
                  : process.currentStage === 'ballot_preparation'
                    ? 'civic_process.stage.ballot_preparation'
                    : process.currentStage === 'voting'
                      ? 'civic_process.stage.voting'
                      : process.currentStage === 'mandate'
                        ? 'civic_process.stage.mandate'
                        : process.currentStage === 'action'
                          ? 'civic_process.stage.action'
                          : process.currentStage === 'verification'
                            ? 'civic_process.stage.verification'
                            : 'civic_process.stage.archived',
          confirmationCount,
          proposalCount,
          deliberationParticipantCount,
          voteCount,
          hasConfirmed,
          canConfirm,
          nextStage:
            process.currentStage === 'confirmation'
              ? 'proposals'
              : process.currentStage === 'proposals'
                ? 'deliberation'
                : process.currentStage === 'deliberation'
                  ? 'ballot_preparation'
                  : process.currentStage === 'ballot_preparation'
                    ? 'voting'
                    : process.currentStage === 'voting'
                      ? 'mandate'
                      : process.currentStage === 'mandate'
                        ? 'action'
                        : process.currentStage === 'action'
                          ? 'verification'
                          : process.currentStage === 'verification'
                            ? 'archived'
                            : null,
          closingAt:
            process.currentStage === 'voting' && process.votingClosesAt
              ? toIsoTimestamp(process.votingClosesAt)
              : null,
          transitionRule:
            process.currentStage === 'confirmation'
              ? {
                  type: 'confirmation_count',
                  requiredConfirmations: CIVIC_CONFIRMATION_THRESHOLD,
                  reached: confirmationCount >= CIVIC_CONFIRMATION_THRESHOLD,
                }
              : process.currentStage === 'proposals'
                ? {
                    type: 'proposal_count',
                    requiredProposals: CIVIC_PROPOSAL_THRESHOLD,
                    reached: proposalCount >= CIVIC_PROPOSAL_THRESHOLD,
                  }
                : process.currentStage === 'deliberation'
                  ? {
                      type: 'deliberation_participation_count',
                      requiredParticipants: CIVIC_DELIBERATION_THRESHOLD,
                      reached: deliberationParticipantCount >= CIVIC_DELIBERATION_THRESHOLD,
                    }
                  : null,
          ballotPreview:
            process.currentStage === 'ballot_preparation' &&
            process.votingOpensAt &&
            process.votingClosesAt
              ? {
                  question: CIVIC_BALLOT_QUESTION,
                  proposals: ballotPreviewProposals
                    .filter((proposal) => proposal.lifecycleState === 'frozen')
                    .map((proposal) => ({
                      id: proposal.id,
                      authorDisplayName: proposal.authorDisplayName,
                      title: proposal.title,
                      body: proposal.body,
                    })),
                  votingOpensAt: toIsoTimestamp(process.votingOpensAt),
                  votingClosesAt: toIsoTimestamp(process.votingClosesAt),
                  ballotType: 'approval' as const,
                  quorum: CIVIC_BALLOT_QUORUM,
                  eligibleVoterCount: eligibleVoterCount,
                  winRuleKey: 'most_approvals_no_tiebreak' as const,
                }
              : null,
          timeline: timeline.map((event) => ({
            type: event.eventType,
            occurredAt: toIsoTimestamp(event.occurredAt),
          })),
          createdAt: toIsoTimestamp(process.createdAt),
          updatedAt: toIsoTimestamp(process.updatedAt),
        },
      });
    },
  );

  app.post(
    '/v1/signals/:signalId/civic-process/viewed',
    {
      schema: {
        tags: ['Civic Process'],
        summary: 'Mark a civic process as viewed by the authenticated member',
        description:
          'Records when the authenticated member last viewed this civic process, so their Civic Inbox can show what changed since. Private per-account bookkeeping only — never exposed publicly and never affects the process itself.',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        params: SignalIdParamsSchema,
        response: {
          200: CivicProcessViewedResponseSchema,
          400: DomainErrorResponseSchema,
          401: DomainErrorResponseSchema,
          403: DomainErrorResponseSchema,
          404: DomainErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const published = await findPublishedSignalById(app.database.db, request.params.signalId);
      if (!published) throw signalNotFoundError();
      const process = await findCivicProcessBySignalId(app.database.db, published.signal.id);
      if (process?.communityId !== published.signal.communityId) {
        throw new Error('Visible signal is missing its canonical civic process');
      }
      const session = await resolveRequiredSession(request);
      const actor = await findActiveCivicActorByAccountId(app.database.db, session.accountId);
      if (!actor) throw civicParticipationNotAuthorizedError();
      const viewedAt = now();
      await markCivicProcessViewed(app.database.db, {
        id: generateId(),
        actorId: actor.id,
        processId: process.id,
        viewedAt,
      });
      return await reply.status(200).send({
        data: {
          processId: process.id,
          viewedAt: toIsoTimestamp(viewedAt),
        },
      });
    },
  );

  done();
};

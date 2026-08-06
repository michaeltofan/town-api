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
  findCivicProposalByProcessAndActor,
  findCivicProposalById,
  insertCivicProposal,
  listCivicProposals,
  reviseCivicProposal,
  withdrawCivicProposal,
  type CivicProposalView,
} from '../db/repositories/civic-proposals.js';
import { findCivicProcessBySignalId } from '../db/repositories/civic-processes.js';
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
  CivicProposalBodySchema,
  CivicProposalRouteResponses,
} from '../schemas/civic-proposals.js';
import { SignalProposalIdParamsSchema } from '../schemas/civic-deliberation.js';
import { ERROR_CODE } from '../schemas/error.js';
import { SignalIdParamsSchema } from '../schemas/signals.js';

export type CivicProposalRoutesOptions = {
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
  return new AppError(409, 'CIVIC_PROPOSAL_STAGE_CLOSED', 'The proposal stage is not open.');
}

function alreadySubmittedError(): AppError {
  return new AppError(
    409,
    'CIVIC_PROPOSAL_ALREADY_SUBMITTED',
    'This member has already submitted a proposal.',
  );
}

function proposalNotFoundError(): AppError {
  return new AppError(404, ERROR_CODE.NOT_FOUND, 'Proposal not found.');
}

function notProposalAuthorError(): AppError {
  return new AppError(403, 'CIVIC_PROPOSAL_NOT_AUTHOR', 'Only the proposal author may do this.');
}

function alreadyRevisedError(): AppError {
  return new AppError(
    409,
    'CIVIC_PROPOSAL_ALREADY_REVISED',
    'A proposal can only be revised once.',
  );
}

function alreadyWithdrawnError(): AppError {
  return new AppError(
    409,
    'CIVIC_PROPOSAL_ALREADY_WITHDRAWN',
    'This proposal has already been withdrawn.',
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

export const civicProposalRoutes: FastifyPluginCallbackTypebox<CivicProposalRoutesOptions> = (
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
    const process = await findCivicProcessBySignalId(app.database.db, published.signal.id);
    if (process?.communityId !== published.signal.communityId) {
      throw new Error('Visible signal is missing its canonical civic process');
    }
    return { published, process };
  }

  function toProposalResponse(
    proposal: CivicProposalView,
    context: { actorId: string | null; currentStage: string },
  ) {
    const isMine = context.actorId === proposal.authorActorId;
    return {
      id: proposal.id,
      authorDisplayName: proposal.authorDisplayName,
      title: proposal.title,
      body: proposal.body,
      targetInstitution: proposal.targetInstitution,
      expectedOutcome: proposal.expectedOutcome,
      estimatedResources: proposal.estimatedResources,
      indicativeDeadline: proposal.indicativeDeadline,
      lifecycleState: proposal.lifecycleState,
      revisedAt: proposal.revisedAt ? toIsoTimestamp(proposal.revisedAt) : null,
      withdrawnAt: proposal.withdrawnAt ? toIsoTimestamp(proposal.withdrawnAt) : null,
      frozenAt: proposal.frozenAt ? toIsoTimestamp(proposal.frozenAt) : null,
      createdAt: toIsoTimestamp(proposal.createdAt),
      isMine,
      canRevise:
        isMine && proposal.lifecycleState === 'published' && context.currentStage === 'proposals',
      canWithdraw:
        isMine &&
        (proposal.lifecycleState === 'published' || proposal.lifecycleState === 'revised'),
    };
  }

  function normalizeOptionalField(value: string | undefined): string | null {
    if (value === undefined) return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  app.get(
    '/v1/signals/:signalId/civic-process/proposals',
    {
      schema: {
        tags: ['Civic Process'],
        summary: 'List structured proposals for a civic process',
        description:
          'Public ordered proposals for a visible signal. Optional session state derives only canPropose, isMine, canRevise, canWithdraw. Never exposes account or actor identifiers.',
        params: SignalIdParamsSchema,
        response: CivicProposalRouteResponses.read,
      },
    },
    async (request, reply) => {
      const { published, process } = await visibleProcess(request.params.signalId);
      const session = await resolveSession(request, false, false);
      const actor = await participantActor(
        session?.accountId ?? null,
        published.signal.communityId,
      );
      const proposals = await listCivicProposals(app.database.db, process.id);
      const own = actor
        ? await findCivicProposalByProcessAndActor(app.database.db, {
            processId: process.id,
            actorId: actor.id,
          })
        : null;
      return await reply.status(200).send({
        data: {
          processId: process.id,
          currentStage: process.currentStage,
          canPropose: process.currentStage === 'proposals' && actor !== null && own === null,
          proposals: proposals.map((proposal) =>
            toProposalResponse(proposal, {
              actorId: actor?.id ?? null,
              currentStage: process.currentStage,
            }),
          ),
        },
      });
    },
  );

  app.post(
    '/v1/signals/:signalId/civic-process/proposals',
    {
      schema: {
        tags: ['Civic Process'],
        summary: 'Submit one structured proposal to an open civic process',
        description:
          'Creates one proposal per eligible civic actor while the canonical process is in proposals. Session and CSRF rules are unchanged. Does not transition the process or create a vote.',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        params: SignalIdParamsSchema,
        body: CivicProposalBodySchema,
        response: CivicProposalRouteResponses.create,
      },
    },
    async (request, reply) => {
      const { published, process } = await visibleProcess(request.params.signalId);
      if (process.currentStage !== 'proposals') throw stageClosedError();
      const session = await resolveSession(request, true, true);
      if (!session) throw sessionNotAuthorizedError();
      const actor = await participantActor(session.accountId, published.signal.communityId);
      if (!actor) throw civicParticipationNotAuthorizedError();
      const title = request.body.title.trim();
      const body = request.body.body.trim();
      const expectedOutcome = request.body.expectedOutcome.trim();
      if (!title || !body || !expectedOutcome) throw validationError();
      const targetInstitution = normalizeOptionalField(request.body.targetInstitution);
      const estimatedResources = normalizeOptionalField(request.body.estimatedResources);
      const indicativeDeadline = request.body.indicativeDeadline ?? null;
      const existing = await findCivicProposalByProcessAndActor(app.database.db, {
        processId: process.id,
        actorId: actor.id,
      });
      if (existing) throw alreadySubmittedError();
      const proposalId = generateId();
      const createdAt = now();
      try {
        await insertCivicProposal(app.database.db, {
          id: proposalId,
          processId: process.id,
          actorId: actor.id,
          title,
          body,
          targetInstitution,
          expectedOutcome,
          estimatedResources,
          indicativeDeadline,
          createdAt,
        });
      } catch (error: unknown) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          (error as { code?: unknown }).code === '23505'
        ) {
          throw alreadySubmittedError();
        }
        throw error;
      }
      return await reply.status(201).send({
        data: {
          id: proposalId,
          authorDisplayName: actor.displayLabel,
          title,
          body,
          targetInstitution,
          expectedOutcome,
          estimatedResources,
          indicativeDeadline,
          lifecycleState: 'published' as const,
          revisedAt: null,
          withdrawnAt: null,
          frozenAt: null,
          createdAt: toIsoTimestamp(createdAt),
          isMine: true,
          canRevise: true,
          canWithdraw: true,
        },
      });
    },
  );

  app.put(
    '/v1/signals/:signalId/civic-process/proposals/:proposalId',
    {
      schema: {
        tags: ['Civic Process'],
        summary: "Revise the author's own proposal exactly once",
        description:
          'A proposal may be revised exactly once, only by its author, only while the process is still in the proposals stage. The prior content is preserved in the append-only revision ledger. Enforced at the database level, not just here.',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        params: SignalProposalIdParamsSchema,
        body: CivicProposalBodySchema,
        response: CivicProposalRouteResponses.revise,
      },
    },
    async (request, reply) => {
      const { published, process } = await visibleProcess(request.params.signalId);
      const session = await resolveSession(request, true, true);
      if (!session) throw sessionNotAuthorizedError();
      const actor = await participantActor(session.accountId, published.signal.communityId);
      if (!actor) throw civicParticipationNotAuthorizedError();
      const title = request.body.title.trim();
      const body = request.body.body.trim();
      const expectedOutcome = request.body.expectedOutcome.trim();
      if (!title || !body || !expectedOutcome) throw validationError();
      const targetInstitution = normalizeOptionalField(request.body.targetInstitution);
      const estimatedResources = normalizeOptionalField(request.body.estimatedResources);
      const indicativeDeadline = request.body.indicativeDeadline ?? null;
      const outcome = await reviseCivicProposal(app.database.db, {
        proposalId: request.params.proposalId,
        actorId: actor.id,
        title,
        body,
        targetInstitution,
        expectedOutcome,
        estimatedResources,
        indicativeDeadline,
      });
      if (outcome === 'not_found') throw proposalNotFoundError();
      if (outcome === 'not_author') throw notProposalAuthorError();
      if (outcome === 'db_rejected') throw alreadyRevisedError();
      const revised = await findCivicProposalById(app.database.db, request.params.proposalId);
      if (!revised) throw proposalNotFoundError();
      return await reply.status(200).send({
        data: toProposalResponse(revised, {
          actorId: actor.id,
          currentStage: process.currentStage,
        }),
      });
    },
  );

  app.post(
    '/v1/signals/:signalId/civic-process/proposals/:proposalId/withdraw',
    {
      schema: {
        tags: ['Civic Process'],
        summary: "Withdraw the author's own proposal",
        description:
          'Withdrawal is author-only and permanent — a withdrawn proposal keeps its full history visible but is excluded once the process moves past proposals. Allowed at any stage; content cannot change on withdrawal.',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        params: SignalProposalIdParamsSchema,
        response: CivicProposalRouteResponses.withdraw,
      },
    },
    async (request, reply) => {
      const { published, process } = await visibleProcess(request.params.signalId);
      const session = await resolveSession(request, true, true);
      if (!session) throw sessionNotAuthorizedError();
      const actor = await participantActor(session.accountId, published.signal.communityId);
      if (!actor) throw civicParticipationNotAuthorizedError();
      const outcome = await withdrawCivicProposal(app.database.db, {
        proposalId: request.params.proposalId,
        actorId: actor.id,
        withdrawnAt: now(),
      });
      if (outcome === 'not_found') throw proposalNotFoundError();
      if (outcome === 'not_author') throw notProposalAuthorError();
      if (outcome === 'db_rejected') throw alreadyWithdrawnError();
      const withdrawn = await findCivicProposalById(app.database.db, request.params.proposalId);
      if (!withdrawn) throw proposalNotFoundError();
      return await reply.status(200).send({
        data: toProposalResponse(withdrawn, {
          actorId: actor.id,
          currentStage: process.currentStage,
        }),
      });
    },
  );

  done();
};

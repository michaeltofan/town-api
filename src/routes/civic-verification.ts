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
import { closeVotingWindowIfElapsed, findCivicMandate } from '../db/repositories/civic-mandates.js';
import {
  findCivicProcessBySignalId,
  openVotingIfBallotPreparationElapsed,
} from '../db/repositories/civic-processes.js';
import { findCivicProposalById } from '../db/repositories/civic-proposals.js';
import {
  findCivicVerification,
  findCivicVerificationConfirmationByProcessAndActor,
  findVerificationOpenedAt,
  insertCivicVerificationConfirmation,
  insertCivicVerificationEvidence,
  listCivicVerificationConfirmationTallyForProcess,
  listCivicVerificationEvidenceForProcess,
  markActionReadyForVerification,
} from '../db/repositories/civic-verification.js';
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
import { ERROR_CODE } from '../schemas/error.js';
import { SignalIdParamsSchema } from '../schemas/signals.js';
import {
  CivicVerificationConfirmationBodySchema,
  CivicVerificationEvidenceBodySchema,
  CivicVerificationRouteResponses,
} from '../schemas/civic-verification.js';

export type CivicVerificationRoutesOptions = {
  env: Env;
  now?: () => string;
  generateId?: () => string;
  localEligibilityResolver?: LocalParticipationEligibilityResolver;
};

const CIVIC_VERIFICATION_DISPUTE_ESCALATION_DAYS = 14;

function sessionNotAuthorizedError(): AppError {
  return new AppError(401, 'SESSION_NOT_AUTHORIZED', 'Session is not authorized.');
}

function validationError(): AppError {
  return new AppError(400, ERROR_CODE.VALIDATION_ERROR, 'Request validation failed.');
}

function actionStageClosedError(): AppError {
  return new AppError(409, 'CIVIC_ACTION_STAGE_CLOSED', 'The action stage is not open.');
}

function verificationStageClosedError(): AppError {
  return new AppError(
    409,
    'CIVIC_VERIFICATION_STAGE_CLOSED',
    'The verification stage is not open.',
  );
}

function alreadyConfirmedError(): AppError {
  return new AppError(
    409,
    'CIVIC_VERIFICATION_ALREADY_CONFIRMED',
    'This member has already confirmed the outcome.',
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

export const civicVerificationRoutes: FastifyPluginCallbackTypebox<
  CivicVerificationRoutesOptions
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
    '/v1/signals/:signalId/civic-process/verification',
    {
      schema: {
        tags: ['Civic Process'],
        summary: 'Read the verification status of a decided civic mandate',
        description:
          'Public winning proposal, open evidence log, and live delivered/not-delivered tally for a visible signal. Any active community actor may mark a decided action ready for verification, submit evidence, or confirm one outcome. A dispute that never reaches either threshold is reported honestly with no invented resolution.',
        params: SignalIdParamsSchema,
        response: CivicVerificationRouteResponses.read,
      },
    },
    async (request, reply) => {
      const { published, process } = await visibleProcess(request.params.signalId);
      const session = await resolveSession(request, false, false);
      const actor = await participantActor(
        session?.accountId ?? null,
        published.signal.communityId,
      );
      const isAction = process.currentStage === 'action';
      const isVerification = process.currentStage === 'verification';
      const isArchived = process.currentStage === 'archived';
      const mandate =
        isAction || isVerification || isArchived
          ? await findCivicMandate(app.database.db, process.id)
          : null;
      const [winnerProposal, verification, tally, myConfirmation, evidence, verificationOpenedAt] =
        await Promise.all([
          mandate?.proposalId ? findCivicProposalById(app.database.db, mandate.proposalId) : null,
          isArchived ? findCivicVerification(app.database.db, process.id) : null,
          isVerification || isArchived
            ? listCivicVerificationConfirmationTallyForProcess(app.database.db, process.id)
            : Promise.resolve({ deliveredCount: 0, notDeliveredCount: 0 }),
          actor && (isVerification || isArchived)
            ? findCivicVerificationConfirmationByProcessAndActor(app.database.db, {
                processId: process.id,
                actorId: actor.id,
              })
            : Promise.resolve(null),
          isVerification || isArchived
            ? listCivicVerificationEvidenceForProcess(app.database.db, process.id)
            : Promise.resolve([]),
          isVerification || isArchived
            ? findVerificationOpenedAt(app.database.db, process.id)
            : Promise.resolve(null),
        ]);
      // A dispute that never reaches either threshold is never auto-resolved
      // (§13): after 14 days it just becomes visibly escalated, honestly
      // reported here, pending the procedural-review path §14 will add —
      // exactly like a filed mandate contestation stays "pending" (§10)
      // until that same capability exists.
      const disputeEscalatesAt = verificationOpenedAt
        ? new Date(
            new Date(verificationOpenedAt).getTime() +
              CIVIC_VERIFICATION_DISPUTE_ESCALATION_DAYS * 24 * 60 * 60 * 1000,
          ).toISOString()
        : null;
      const disputeEscalated =
        isVerification &&
        !verification &&
        disputeEscalatesAt !== null &&
        now() > disputeEscalatesAt;
      return await reply.status(200).send({
        data: {
          processId: process.id,
          currentStage:
            process.currentStage === 'action' ||
            process.currentStage === 'verification' ||
            process.currentStage === 'archived'
              ? process.currentStage
              : 'action',
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
          canMarkReady: isAction && actor !== null,
          canConfirm: isVerification && actor !== null && myConfirmation === null,
          hasConfirmed: myConfirmation !== null,
          myOutcome: myConfirmation?.outcome ?? null,
          deliveredCount: verification?.deliveredCount ?? tally.deliveredCount,
          notDeliveredCount: verification?.notDeliveredCount ?? tally.notDeliveredCount,
          outcome: verification?.outcome ?? null,
          decidedAt: verification ? toIsoTimestamp(verification.decidedAt) : null,
          verificationOpenedAt: verificationOpenedAt ? toIsoTimestamp(verificationOpenedAt) : null,
          disputeEscalatesAt: disputeEscalatesAt,
          disputeEscalated,
          evidence: evidence.map((item) => ({
            id: item.id,
            authorDisplayName: item.authorDisplayName,
            text: item.text,
            url: item.url,
            createdAt: toIsoTimestamp(item.createdAt),
            isMine: actor?.id === item.authorActorId,
          })),
        },
      });
    },
  );

  app.post(
    '/v1/signals/:signalId/civic-process/verification/ready',
    {
      schema: {
        tags: ['Civic Process'],
        summary: 'Mark a decided action ready for verification',
        description:
          'Any active community actor may mark the action ready for verification. No threshold: the first eligible actor to call this moves the process into verification immediately.',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        params: SignalIdParamsSchema,
        response: CivicVerificationRouteResponses.ready,
      },
    },
    async (request, reply) => {
      const { published, process } = await visibleProcess(request.params.signalId);
      if (process.currentStage !== 'action') throw actionStageClosedError();
      const session = await resolveSession(request, true, true);
      if (!session) throw sessionNotAuthorizedError();
      const actor = await participantActor(session.accountId, published.signal.communityId);
      if (!actor) throw civicParticipationNotAuthorizedError();
      await markActionReadyForVerification(app.database.db, {
        processId: process.id,
        now: now(),
      });
      const updated = await findCivicProcessBySignalId(app.database.db, published.signal.id);
      return await reply.status(200).send({
        data: {
          processId: process.id,
          currentStage: updated?.currentStage === 'verification' ? 'verification' : 'action',
        },
      });
    },
  );

  app.post(
    '/v1/signals/:signalId/civic-process/verification/evidence',
    {
      schema: {
        tags: ['Civic Process'],
        summary: 'Post evidence toward verifying a civic mandate',
        description:
          'Creates a short, structured evidence entry (text and an optional supporting link) while the canonical process is in verification. Does not itself decide the outcome.',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        params: SignalIdParamsSchema,
        body: CivicVerificationEvidenceBodySchema,
        response: CivicVerificationRouteResponses.evidence,
      },
    },
    async (request, reply) => {
      const { published, process } = await visibleProcess(request.params.signalId);
      if (process.currentStage !== 'verification') throw verificationStageClosedError();
      const session = await resolveSession(request, true, true);
      if (!session) throw sessionNotAuthorizedError();
      const actor = await participantActor(session.accountId, published.signal.communityId);
      if (!actor) throw civicParticipationNotAuthorizedError();
      const text = request.body.text.trim();
      if (text.length < 12 || text.length > 480) throw validationError();
      const url = request.body.url ? request.body.url.trim() : null;
      if (url && (url.length > 500 || !/^https?:\/\//.test(url))) throw validationError();
      const evidenceId = generateId();
      const createdAt = now();
      try {
        await insertCivicVerificationEvidence(app.database.db, {
          id: evidenceId,
          processId: process.id,
          actorId: actor.id,
          text,
          url,
          createdAt,
        });
      } catch (error: unknown) {
        if (error instanceof Error && error.message.includes('stage is closed')) {
          throw verificationStageClosedError();
        }
        throw error;
      }
      return await reply.status(201).send({
        data: {
          id: evidenceId,
          authorDisplayName: actor.displayLabel,
          text,
          url,
          createdAt: toIsoTimestamp(createdAt),
          isMine: true,
        },
      });
    },
  );

  app.post(
    '/v1/signals/:signalId/civic-process/verification/confirm',
    {
      schema: {
        tags: ['Civic Process'],
        summary: 'Confirm whether the mandated action was delivered',
        description:
          'Records one delivered/not-delivered confirmation per eligible actor while the canonical process is in verification. Once either outcome reaches five confirmations, the process archives with that outcome. A dispute that never reaches either threshold stays open with no invented resolution.',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        params: SignalIdParamsSchema,
        body: CivicVerificationConfirmationBodySchema,
        response: CivicVerificationRouteResponses.confirm,
      },
    },
    async (request, reply) => {
      const { published, process } = await visibleProcess(request.params.signalId);
      if (process.currentStage !== 'verification') throw verificationStageClosedError();
      const session = await resolveSession(request, true, true);
      if (!session) throw sessionNotAuthorizedError();
      const actor = await participantActor(session.accountId, published.signal.communityId);
      if (!actor) throw civicParticipationNotAuthorizedError();
      const existing = await findCivicVerificationConfirmationByProcessAndActor(app.database.db, {
        processId: process.id,
        actorId: actor.id,
      });
      if (existing) throw alreadyConfirmedError();
      const createdAt = now();
      try {
        await insertCivicVerificationConfirmation(app.database.db, {
          id: generateId(),
          processId: process.id,
          actorId: actor.id,
          outcome: request.body.outcome,
          createdAt,
        });
      } catch (error: unknown) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          (error as { code?: unknown }).code === '23505'
        ) {
          throw alreadyConfirmedError();
        }
        if (error instanceof Error && error.message.includes('stage is closed')) {
          throw verificationStageClosedError();
        }
        throw error;
      }
      return await reply.status(201).send({
        data: {
          outcome: request.body.outcome,
          createdAt: toIsoTimestamp(createdAt),
        },
      });
    },
  );

  done();
};

import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import type { Env } from '../config/env.js';
import { requirePasskeyManagementConfig } from '../ceremony/passkey-management/config.js';
import {
  parseSessionAuthorizationHeader,
  parseWebSessionCookie,
} from '../ceremony/passkey-authentication/session-transport.js';
import { resolveActiveSession } from '../ceremony/passkey-authentication/service.js';
import {
  countConfirmationsForSignal,
  findActiveCivicActorByAccountId,
  findConfirmationByActorAndSignal,
} from '../db/repositories/confirmations.js';
import {
  CIVIC_CONFIRMATION_THRESHOLD,
  findCivicProcessBySignalId,
  listPublicCivicProcessEvents,
} from '../db/repositories/civic-processes.js';
import { findPublishedSignalById } from '../db/repositories/signals.js';
import { signalNotFoundError } from '../errors/app-error.js';
import { findAccountById } from '../identity/repositories/accounts.js';
import { toIsoTimestamp } from '../lib/timestamps.js';
import { evaluateCivicAccess } from '../membership/civic-access.js';
import {
  createDefaultLocalEligibilityResolver,
  type LocalParticipationEligibilityResolver,
} from '../membership/local-eligibility.js';
import { findEntitlementByAccountId } from '../membership/repositories/entitlements.js';
import { CivicProcessResponseSchema } from '../schemas/civic-process.js';
import { DomainErrorResponseSchema } from '../schemas/error.js';
import { SignalIdParamsSchema } from '../schemas/signals.js';

export type CivicProcessRoutesOptions = {
  env: Env;
  now?: () => string;
  localEligibilityResolver?: LocalParticipationEligibilityResolver;
};

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

      const process = await findCivicProcessBySignalId(app.database.db, published.signal.id);
      if (process?.communityId !== published.signal.communityId) {
        throw new Error('Visible signal is missing its canonical civic process');
      }

      const [confirmationCount, timeline, accountId] = await Promise.all([
        countConfirmationsForSignal(app.database.db, published.signal.id),
        listPublicCivicProcessEvents(app.database.db, process.id),
        resolveOptionalSessionAccountId(request),
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
              : 'civic_process.stage.proposals',
          confirmationCount,
          hasConfirmed,
          canConfirm,
          nextStage: process.currentStage === 'confirmation' ? 'proposals' : 'deliberation',
          closingAt: null,
          transitionRule: {
            type: 'confirmation_count',
            requiredConfirmations: CIVIC_CONFIRMATION_THRESHOLD,
            reached: confirmationCount >= CIVIC_CONFIRMATION_THRESHOLD,
          },
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

  done();
};

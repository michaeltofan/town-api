import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import type { Env } from '../config/env.js';
import { closeVotingWindowIfElapsed, findCivicMandate } from '../db/repositories/civic-mandates.js';
import { findCivicProcessBySignalId } from '../db/repositories/civic-processes.js';
import { findCivicProposalById } from '../db/repositories/civic-proposals.js';
import { findPublishedSignalById } from '../db/repositories/signals.js';
import { signalNotFoundError } from '../errors/app-error.js';
import { toIsoTimestamp } from '../lib/timestamps.js';
import { CivicMandateRouteResponses } from '../schemas/civic-mandate.js';
import { SignalIdParamsSchema } from '../schemas/signals.js';

export type CivicMandateRoutesOptions = {
  env: Env;
  now?: () => string;
};

export const civicMandateRoutes: FastifyPluginCallbackTypebox<CivicMandateRoutesOptions> = (
  app,
  options,
  done,
) => {
  const now = options.now ?? (() => new Date().toISOString());

  app.get(
    '/v1/signals/:signalId/civic-process/mandate',
    {
      schema: {
        tags: ['Civic Process'],
        summary: 'Read the civic mandate for a process once voting has closed',
        description:
          'Public final result for a visible signal. Voting closes lazily the moment any request observes an elapsed voting window (no scheduled job). A perfect tie among the top vote counts is reported as contested with no winner — no tie-break rule is invented. Never exposes who voted for what.',
        params: SignalIdParamsSchema,
        response: CivicMandateRouteResponses.read,
      },
    },
    async (request, reply) => {
      const published = await findPublishedSignalById(app.database.db, request.params.signalId);
      if (!published) throw signalNotFoundError();
      const initialProcess = await findCivicProcessBySignalId(app.database.db, published.signal.id);
      if (initialProcess?.communityId !== published.signal.communityId) {
        throw new Error('Visible signal is missing its canonical civic process');
      }

      const nowIso = now();
      if (initialProcess.currentStage === 'voting') {
        await closeVotingWindowIfElapsed(app.database.db, {
          processId: initialProcess.id,
          now: nowIso,
        });
      }
      const process = await findCivicProcessBySignalId(app.database.db, published.signal.id);
      if (!process) throw new Error('Civic process disappeared after lazy close check');

      const mandate =
        process.currentStage === 'mandate' || process.currentStage === 'action'
          ? await findCivicMandate(app.database.db, process.id)
          : null;
      const winnerProposal = mandate?.proposalId
        ? await findCivicProposalById(app.database.db, mandate.proposalId)
        : null;

      return await reply.status(200).send({
        data: {
          processId: process.id,
          currentStage:
            process.currentStage === 'voting' ||
            process.currentStage === 'mandate' ||
            process.currentStage === 'action'
              ? process.currentStage
              : 'voting',
          decided: process.currentStage === 'mandate' || process.currentStage === 'action',
          contested: mandate !== null && mandate.proposalId === null,
          winner: winnerProposal
            ? {
                proposalId: winnerProposal.id,
                authorDisplayName: winnerProposal.authorDisplayName,
                title: winnerProposal.title,
                body: winnerProposal.body,
                voteCount: mandate?.voteCount ?? 0,
              }
            : null,
          totalVotes: mandate?.totalVotes ?? 0,
          votingClosesAt: process.votingClosesAt ? toIsoTimestamp(process.votingClosesAt) : null,
          decidedAt: mandate ? toIsoTimestamp(mandate.decidedAt) : null,
        },
      });
    },
  );

  done();
};

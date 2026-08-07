import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import type { Env } from '../config/env.js';
import { closeVotingWindowIfElapsed, findCivicMandate } from '../db/repositories/civic-mandates.js';
import {
  findCivicProcessBySignalId,
  openVotingIfBallotPreparationElapsed,
  quorumFailedForBallotCycle,
} from '../db/repositories/civic-processes.js';
import { countCivicVotesForProcess } from '../db/repositories/civic-votes.js';
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
      if (initialProcess.currentStage === 'ballot_preparation') {
        await openVotingIfBallotPreparationElapsed(app.database.db, {
          processId: initialProcess.id,
          now: nowIso,
        });
      }
      if (initialProcess.currentStage === 'voting') {
        await closeVotingWindowIfElapsed(app.database.db, {
          processId: initialProcess.id,
          now: nowIso,
        });
      }
      const process = await findCivicProcessBySignalId(app.database.db, published.signal.id);
      if (!process) throw new Error('Civic process disappeared after lazy close check');

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
              }
            : null,
          totalVotes: quorumFailed ? quorumFailedVoteCount : (mandate?.totalVotes ?? 0),
          votingClosesAt: process.votingClosesAt ? toIsoTimestamp(process.votingClosesAt) : null,
          decidedAt: mandate ? toIsoTimestamp(mandate.decidedAt) : null,
        },
      });
    },
  );

  done();
};

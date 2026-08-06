import { Type, type Static } from '@sinclair/typebox';

export const CivicProcessStageSchema = Type.Union(
  [
    Type.Literal('confirmation'),
    Type.Literal('proposals'),
    Type.Literal('deliberation'),
    Type.Literal('ballot_preparation'),
    Type.Literal('voting'),
    Type.Literal('mandate'),
    Type.Literal('action'),
    Type.Literal('verification'),
    Type.Literal('archived'),
  ],
  { $id: 'CivicProcessStage' },
);

const PublicCivicProcessStageSchema = Type.Unsafe<
  | 'confirmation'
  | 'proposals'
  | 'deliberation'
  | 'ballot_preparation'
  | 'voting'
  | 'mandate'
  | 'action'
  | 'verification'
  | 'archived'
>({
  type: 'string',
  enum: [
    'confirmation',
    'proposals',
    'deliberation',
    'ballot_preparation',
    'voting',
    'mandate',
    'action',
    'verification',
    'archived',
  ],
});

const PublicCivicProcessStageLabelSchema = Type.Unsafe<
  | 'civic_process.stage.confirmation'
  | 'civic_process.stage.proposals'
  | 'civic_process.stage.deliberation'
  | 'civic_process.stage.ballot_preparation'
  | 'civic_process.stage.voting'
  | 'civic_process.stage.mandate'
  | 'civic_process.stage.action'
  | 'civic_process.stage.verification'
  | 'civic_process.stage.archived'
>({
  type: 'string',
  enum: [
    'civic_process.stage.confirmation',
    'civic_process.stage.proposals',
    'civic_process.stage.deliberation',
    'civic_process.stage.ballot_preparation',
    'civic_process.stage.voting',
    'civic_process.stage.mandate',
    'civic_process.stage.action',
    'civic_process.stage.verification',
    'civic_process.stage.archived',
  ],
});

const PublicCivicProcessNextStageSchema = Type.Unsafe<
  | 'proposals'
  | 'deliberation'
  | 'ballot_preparation'
  | 'voting'
  | 'mandate'
  | 'action'
  | 'verification'
  | 'archived'
>({
  type: 'string',
  enum: [
    'proposals',
    'deliberation',
    'ballot_preparation',
    'voting',
    'mandate',
    'action',
    'verification',
    'archived',
  ],
});

const CivicProcessTimelineEventSchema = Type.Object(
  {
    type: Type.Unsafe<
      | 'process_created'
      | 'stage_transitioned_to_proposals'
      | 'stage_transitioned_to_deliberation'
      | 'stage_transitioned_to_ballot_preparation'
      | 'stage_transitioned_to_voting'
      | 'stage_transitioned_to_mandate'
      | 'stage_transitioned_to_action'
      | 'stage_transitioned_to_verification'
      | 'stage_transitioned_to_archived'
    >({
      type: 'string',
      enum: [
        'process_created',
        'stage_transitioned_to_proposals',
        'stage_transitioned_to_deliberation',
        'stage_transitioned_to_ballot_preparation',
        'stage_transitioned_to_voting',
        'stage_transitioned_to_mandate',
        'stage_transitioned_to_action',
        'stage_transitioned_to_verification',
        'stage_transitioned_to_archived',
      ],
    }),
    occurredAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false, $id: 'CivicProcessTimelineEvent' },
);

const CivicProcessTransitionRuleSchema = Type.Union(
  [
    Type.Object(
      {
        type: Type.Literal('confirmation_count'),
        requiredConfirmations: Type.Integer({ minimum: 5, maximum: 5 }),
        reached: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        type: Type.Literal('proposal_count'),
        requiredProposals: Type.Integer({ minimum: 5, maximum: 5 }),
        reached: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        type: Type.Literal('deliberation_participation_count'),
        requiredParticipants: Type.Integer({ minimum: 5, maximum: 5 }),
        reached: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    Type.Null(),
  ],
  { $id: 'CivicProcessTransitionRule' },
);

const CivicBallotPreviewProposalSchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    authorDisplayName: Type.String({ minLength: 1 }),
    title: Type.String({ minLength: 1, maxLength: 160 }),
    body: Type.String({ minLength: 1, maxLength: 2000 }),
  },
  { additionalProperties: false },
);

const CivicBallotPreviewSchema = Type.Union(
  [
    Type.Object(
      {
        question: Type.Literal("Which proposal should this signal's mandate be?"),
        proposals: Type.Array(CivicBallotPreviewProposalSchema, { maxItems: 100 }),
        votingOpensAt: Type.String({ format: 'date-time' }),
        votingClosesAt: Type.String({ format: 'date-time' }),
        ballotType: Type.Literal('approval'),
        quorum: Type.Integer({ minimum: 5, maximum: 5 }),
        eligibleVoterCount: Type.Integer({ minimum: 0 }),
        winRuleKey: Type.Literal('most_approvals_no_tiebreak'),
      },
      { additionalProperties: false },
    ),
    Type.Null(),
  ],
  { $id: 'CivicBallotPreview' },
);

export const CivicProcessResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        id: Type.String({ format: 'uuid' }),
        signalId: Type.String({ format: 'uuid' }),
        communitySlug: Type.String({ minLength: 1 }),
        currentStage: PublicCivicProcessStageSchema,
        stageLabelKey: PublicCivicProcessStageLabelSchema,
        confirmationCount: Type.Integer({ minimum: 0 }),
        proposalCount: Type.Integer({ minimum: 0 }),
        deliberationParticipantCount: Type.Integer({ minimum: 0 }),
        voteCount: Type.Integer({ minimum: 0 }),
        hasConfirmed: Type.Boolean(),
        canConfirm: Type.Boolean(),
        nextStage: Type.Union([PublicCivicProcessNextStageSchema, Type.Null()]),
        closingAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
        transitionRule: CivicProcessTransitionRuleSchema,
        ballotPreview: CivicBallotPreviewSchema,
        timeline: Type.Array(CivicProcessTimelineEventSchema, { maxItems: 50 }),
        createdAt: Type.String({ format: 'date-time' }),
        updatedAt: Type.String({ format: 'date-time' }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'CivicProcessResponse' },
);

export const CivicProcessViewedResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        processId: Type.String({ format: 'uuid' }),
        viewedAt: Type.String({ format: 'date-time' }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'CivicProcessViewedResponse' },
);

export type CivicProcessStage = Static<typeof CivicProcessStageSchema>;
export type CivicProcessResponse = Static<typeof CivicProcessResponseSchema>;

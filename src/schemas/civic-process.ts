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

const PublicCivicProcessStageSchema = Type.Unsafe<'confirmation' | 'proposals'>({
  type: 'string',
  enum: ['confirmation', 'proposals'],
});

const PublicCivicProcessStageLabelSchema = Type.Unsafe<
  'civic_process.stage.confirmation' | 'civic_process.stage.proposals'
>({
  type: 'string',
  enum: ['civic_process.stage.confirmation', 'civic_process.stage.proposals'],
});

const PublicCivicProcessNextStageSchema = Type.Unsafe<'proposals' | 'deliberation'>({
  type: 'string',
  enum: ['proposals', 'deliberation'],
});

const CivicProcessTimelineEventSchema = Type.Object(
  {
    type: Type.Unsafe<'process_created' | 'stage_transitioned_to_proposals'>({
      type: 'string',
      enum: ['process_created', 'stage_transitioned_to_proposals'],
    }),
    occurredAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false, $id: 'CivicProcessTimelineEvent' },
);

const CivicProcessTransitionRuleSchema = Type.Object(
  {
    type: Type.Literal('confirmation_count'),
    requiredConfirmations: Type.Integer({ minimum: 5, maximum: 5 }),
    reached: Type.Boolean(),
  },
  { additionalProperties: false, $id: 'CivicProcessTransitionRule' },
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
        hasConfirmed: Type.Boolean(),
        canConfirm: Type.Boolean(),
        nextStage: PublicCivicProcessNextStageSchema,
        closingAt: Type.Null(),
        transitionRule: CivicProcessTransitionRuleSchema,
        timeline: Type.Array(CivicProcessTimelineEventSchema, { maxItems: 50 }),
        createdAt: Type.String({ format: 'date-time' }),
        updatedAt: Type.String({ format: 'date-time' }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'CivicProcessResponse' },
);

export type CivicProcessStage = Static<typeof CivicProcessStageSchema>;
export type CivicProcessResponse = Static<typeof CivicProcessResponseSchema>;

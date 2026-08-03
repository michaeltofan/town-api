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

const CivicProcessTimelineEventSchema = Type.Object(
  {
    type: Type.Literal('process_created'),
    occurredAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false, $id: 'CivicProcessTimelineEvent' },
);

export const CivicProcessResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        id: Type.String({ format: 'uuid' }),
        signalId: Type.String({ format: 'uuid' }),
        communitySlug: Type.String({ minLength: 1 }),
        currentStage: Type.Literal('confirmation'),
        stageLabelKey: Type.Literal('civic_process.stage.confirmation'),
        confirmationCount: Type.Integer({ minimum: 0 }),
        hasConfirmed: Type.Boolean(),
        canConfirm: Type.Boolean(),
        nextStage: Type.Literal('proposals'),
        closingAt: Type.Null(),
        transitionRule: Type.Null(),
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

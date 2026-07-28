import { Type, type Static } from '@sinclair/typebox';

export const SIGNAL_HIDE_REASONS = [
  'immoral',
  'abusive',
  'spam',
  'off_topic',
  'illegal',
  'other',
] as const;

export const SignalHideReasonSchema = Type.Union(
  [
    Type.Literal('immoral'),
    Type.Literal('abusive'),
    Type.Literal('spam'),
    Type.Literal('off_topic'),
    Type.Literal('illegal'),
    Type.Literal('other'),
  ],
  { $id: 'SignalHideReason' },
);

export const SignalHideBodySchema = Type.Object(
  {
    reason: SignalHideReasonSchema,
  },
  { additionalProperties: false, $id: 'SignalHideBody' },
);

export const SignalUnhideBodySchema = Type.Object(
  {},
  { additionalProperties: false, $id: 'SignalUnhideBody' },
);

export const SignalModerationResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        signalId: Type.String({ format: 'uuid' }),
        hidden: Type.Boolean(),
        hiddenAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
        hiddenReason: Type.Union([SignalHideReasonSchema, Type.Null()]),
        changed: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'SignalModerationResponse' },
);

export type SignalHideBody = Static<typeof SignalHideBodySchema>;
export type SignalModerationResponse = Static<typeof SignalModerationResponseSchema>;

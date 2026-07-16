import { Type, type Static } from '@sinclair/typebox';

export const ConfirmationStateSchema = Type.Object(
  {
    signalId: Type.String({ format: 'uuid' }),
    confirmed: Type.Boolean(),
    confirmedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  },
  { additionalProperties: false, $id: 'ConfirmationState' },
);

export const ConfirmationResponseSchema = Type.Object(
  {
    data: ConfirmationStateSchema,
  },
  { additionalProperties: false, $id: 'ConfirmationResponse' },
);

export const ConfirmationPutBodySchema = Type.Object(
  {},
  {
    additionalProperties: false,
    $id: 'ConfirmationPutBody',
    description: 'Empty body. Unexpected properties are rejected.',
  },
);

export const ControlledAccessHeaderSchema = Type.Object(
  {
    'x-town-control-key': Type.Optional(Type.String()),
  },
  { additionalProperties: true, $id: 'ControlledAccessHeaders' },
);

export type ConfirmationResponse = Static<typeof ConfirmationResponseSchema>;

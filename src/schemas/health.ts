import { Type, type Static } from '@sinclair/typebox';

export const LiveResponseSchema = Type.Object(
  {
    status: Type.Literal('ok'),
  },
  {
    additionalProperties: false,
    $id: 'LiveResponse',
  },
);

export const ReadyResponseSchema = Type.Object(
  {
    status: Type.Literal('ready'),
  },
  {
    additionalProperties: false,
    $id: 'ReadyResponse',
  },
);

export const NotReadyResponseSchema = Type.Object(
  {
    status: Type.Literal('not_ready'),
  },
  {
    additionalProperties: false,
    $id: 'NotReadyResponse',
  },
);

export type LiveResponse = Static<typeof LiveResponseSchema>;
export type ReadyResponse = Static<typeof ReadyResponseSchema>;
export type NotReadyResponse = Static<typeof NotReadyResponseSchema>;

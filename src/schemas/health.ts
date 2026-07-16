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

export type LiveResponse = Static<typeof LiveResponseSchema>;
export type ReadyResponse = Static<typeof ReadyResponseSchema>;

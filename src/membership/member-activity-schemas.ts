import { Type, type Static } from '@sinclair/typebox';

const MemberActivitySignalSchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    slug: Type.String(),
    headline: Type.String(),
    community: Type.Object(
      {
        slug: Type.String(),
        displayName: Type.String(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const MemberActivityItemSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('confirmation'),
      occurredAt: Type.String({ format: 'date-time' }),
      signal: MemberActivitySignalSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('contribution'),
      occurredAt: Type.String({ format: 'date-time' }),
      signal: MemberActivitySignalSchema,
      contribution: Type.Object(
        {
          id: Type.String({ format: 'uuid' }),
          text: Type.String(),
          intent: Type.Union([
            Type.Literal('observation'),
            Type.Literal('proposal'),
            Type.Literal('next_step'),
          ]),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('signal_published'),
      occurredAt: Type.String({ format: 'date-time' }),
      signal: MemberActivitySignalSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('signal_evolution'),
      occurredAt: Type.String({ format: 'date-time' }),
      signal: MemberActivitySignalSchema,
      evolution: Type.Object(
        {
          statusLabel: Type.String(),
          statusNote: Type.String(),
          latestUpdate: Type.String(),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
]);

export const MemberActivityResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        items: Type.Array(MemberActivityItemSchema),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'MemberActivityResponse' },
);

export type MemberActivityItem = Static<typeof MemberActivityItemSchema>;
export type MemberActivityResponse = Static<typeof MemberActivityResponseSchema>;

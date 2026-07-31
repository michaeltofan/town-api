import { Type, type Static } from '@sinclair/typebox';

export const ImageFocusSchema = Type.Object(
  {
    x: Type.Integer({ minimum: 0, maximum: 100 }),
    y: Type.Integer({ minimum: 0, maximum: 100 }),
  },
  { additionalProperties: false, $id: 'ImageFocus' },
);

export const SignalListCommunitySchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    slug: Type.String(),
    displayName: Type.String(),
    defaultLocale: Type.String(),
  },
  { additionalProperties: false, $id: 'SignalListCommunity' },
);

export const SignalImageMediaSchema = Type.Object(
  {
    url: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false, $id: 'SignalImageMedia' },
);

export const SignalListItemSchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    slug: Type.String(),
    position: Type.Integer({ minimum: 1 }),
    locale: Type.String(),
    category: Type.String(),
    area: Type.String(),
    headline: Type.String(),
    summary: Type.String(),
    observedLabel: Type.String(),
    imageKey: Type.String(),
    imageFocus: ImageFocusSchema,
    /** Present for member-authored photos; null for foundation static assets. */
    imageMedia: Type.Union([SignalImageMediaSchema, Type.Null()]),
    /** Aggregate civic confirmation total. Integer only — no actor identifiers. */
    confirmationCount: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false, $id: 'SignalListItem' },
);

export const CommunitySignalsResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        community: SignalListCommunitySchema,
        signals: Type.Array(SignalListItemSchema),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'CommunitySignalsResponse' },
);

export const SignalDetailCommunitySchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    slug: Type.String(),
    displayName: Type.String(),
  },
  { additionalProperties: false, $id: 'SignalDetailCommunity' },
);

export const SignalDetailResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        id: Type.String({ format: 'uuid' }),
        slug: Type.String(),
        community: SignalDetailCommunitySchema,
        locale: Type.String(),
        category: Type.String(),
        area: Type.String(),
        headline: Type.String(),
        summary: Type.String(),
        description: Type.String(),
        whyItMatters: Type.String(),
        whoIsAffected: Type.String(),
        latestUpdate: Type.String(),
        statusLabel: Type.String(),
        statusNote: Type.String(),
        observedLabel: Type.String(),
        observedOn: Type.Union([Type.String({ format: 'date' }), Type.Null()]),
        observedPrecision: Type.Union([Type.Literal('day'), Type.Literal('week')]),
        authorDisplayName: Type.String(),
        imageKey: Type.String(),
        imageFocus: ImageFocusSchema,
        /** Present for member-authored photos; null for foundation static assets. */
        imageMedia: Type.Union([SignalImageMediaSchema, Type.Null()]),
        publishedAt: Type.String({ format: 'date-time' }),
        /** Aggregate civic confirmation total. Integer only — no actor identifiers. */
        confirmationCount: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'SignalDetailResponse' },
);

export const SignalIdParamsSchema = Type.Object(
  {
    signalId: Type.String({ format: 'uuid' }),
  },
  { additionalProperties: false, $id: 'SignalIdParams' },
);

export type CommunitySignalsResponse = Static<typeof CommunitySignalsResponseSchema>;
export type SignalDetailResponse = Static<typeof SignalDetailResponseSchema>;

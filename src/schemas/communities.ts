import { Type, type Static } from '@sinclair/typebox';

export const PublicCommunitySchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    slug: Type.String(),
    position: Type.Integer({ minimum: 1 }),
    countryCode: Type.String({ minLength: 2, maxLength: 2 }),
    cityName: Type.String(),
    displayName: Type.String(),
    defaultLocale: Type.String(),
    timezone: Type.String(),
  },
  { additionalProperties: false, $id: 'PublicCommunity' },
);

export const CommunitiesListResponseSchema = Type.Object(
  {
    data: Type.Array(PublicCommunitySchema),
  },
  { additionalProperties: false, $id: 'CommunitiesListResponse' },
);

export const CommunitySlugParamsSchema = Type.Object(
  {
    communitySlug: Type.String({ minLength: 1, maxLength: 100 }),
  },
  { additionalProperties: false, $id: 'CommunitySlugParams' },
);

export type PublicCommunity = Static<typeof PublicCommunitySchema>;
export type CommunitiesListResponse = Static<typeof CommunitiesListResponseSchema>;

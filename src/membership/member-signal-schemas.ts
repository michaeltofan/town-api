import { Type, type Static } from '@sinclair/typebox';
import { DomainErrorResponseSchema } from '../schemas/error.js';
import { CommunitySlugParamsSchema } from '../schemas/communities.js';

export { CommunitySlugParamsSchema };

export const MemberSignalCreateBodySchema = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 160 }),
    description: Type.String({ minLength: 1, maxLength: 2000 }),
    /** Closed set validated against foundation signal categories at runtime. */
    category: Type.String({ minLength: 1, maxLength: 64 }),
    /** Real legal name for publication — not a username or handle. */
    realName: Type.String({ minLength: 3, maxLength: 80 }),
    /**
     * Explicit reaffirmation of existing membership personal-responsibility rules
     * and community commitment. Must be true — not a new agreement type.
     */
    acceptedResponsibility: Type.Boolean(),
    mediaUploadId: Type.String({ format: 'uuid' }),
  },
  { additionalProperties: false, $id: 'MemberSignalCreateBody' },
);

export const MemberSignalMediaUploadCreatedSchema = Type.Object(
  {
    data: Type.Object(
      {
        mediaUploadId: Type.String({ format: 'uuid' }),
        contentType: Type.String(),
        byteSize: Type.Integer({ minimum: 1 }),
        expiresAt: Type.String({ format: 'date-time' }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'MemberSignalMediaUploadCreated' },
);

export const MemberSignalCreatedResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        id: Type.String({ format: 'uuid' }),
        slug: Type.String(),
        status: Type.Literal('published'),
        community: Type.Object(
          {
            slug: Type.String(),
          },
          { additionalProperties: false },
        ),
        authorDisplayName: Type.String(),
        imageMedia: Type.Object(
          {
            contentType: Type.String(),
            byteSize: Type.Integer({ minimum: 1 }),
            url: Type.String({ minLength: 1 }),
          },
          { additionalProperties: false },
        ),
        publishedAt: Type.String({ format: 'date-time' }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'MemberSignalCreatedResponse' },
);

export const MemberSignalRouteResponses = {
  mediaUpload: {
    201: MemberSignalMediaUploadCreatedSchema,
    400: DomainErrorResponseSchema,
    401: DomainErrorResponseSchema,
    403: DomainErrorResponseSchema,
    404: DomainErrorResponseSchema,
    503: DomainErrorResponseSchema,
  },
  create: {
    201: MemberSignalCreatedResponseSchema,
    400: DomainErrorResponseSchema,
    401: DomainErrorResponseSchema,
    403: DomainErrorResponseSchema,
    404: DomainErrorResponseSchema,
    429: DomainErrorResponseSchema,
    503: DomainErrorResponseSchema,
  },
} as const;

export type MemberSignalCreateBody = Static<typeof MemberSignalCreateBodySchema>;

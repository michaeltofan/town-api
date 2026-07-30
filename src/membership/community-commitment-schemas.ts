import { Type, type Static } from '@sinclair/typebox';
import { DomainErrorResponseSchema } from '../schemas/error.js';

export const CommunityCommitmentPutBodySchema = Type.Object(
  {
    community: Type.String({ minLength: 1, maxLength: 100 }),
    accepted: Type.Literal(true),
  },
  { additionalProperties: false, $id: 'CommunityCommitmentPutBody' },
);

const CommunityCommitmentDataSchema = Type.Object(
  {
    status: Type.Union([Type.Literal('none'), Type.Literal('recorded')]),
    community: Type.Union([
      Type.Null(),
      Type.Object(
        {
          slug: Type.String(),
          displayName: Type.String(),
          cityName: Type.String(),
          countryCode: Type.String({ minLength: 2, maxLength: 2 }),
        },
        { additionalProperties: false },
      ),
    ]),
    accepted: Type.Boolean(),
    acceptedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    commitmentVersion: Type.Union([Type.String(), Type.Null()]),
    editable: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const CommunityCommitmentResponseSchema = Type.Object(
  {
    data: CommunityCommitmentDataSchema,
  },
  { additionalProperties: false, $id: 'CommunityCommitmentResponse' },
);

export const CommunityCommitmentRouteResponses = {
  read: {
    200: CommunityCommitmentResponseSchema,
    400: DomainErrorResponseSchema,
    401: DomainErrorResponseSchema,
    429: DomainErrorResponseSchema,
  },
  write: {
    200: CommunityCommitmentResponseSchema,
    400: DomainErrorResponseSchema,
    401: DomainErrorResponseSchema,
    404: DomainErrorResponseSchema,
    409: DomainErrorResponseSchema,
    429: DomainErrorResponseSchema,
    500: DomainErrorResponseSchema,
  },
} as const;

export type CommunityCommitmentPutBody = Static<typeof CommunityCommitmentPutBodySchema>;
export type CommunityCommitmentResponse = Static<typeof CommunityCommitmentResponseSchema>;

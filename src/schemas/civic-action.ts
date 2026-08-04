import { Type, type Static } from '@sinclair/typebox';
import { CivicMandateWinnerSchema } from './civic-mandate.js';
import { DomainErrorResponseSchema } from './error.js';

export const CivicActionUpdateBodySchema = Type.Object(
  {
    text: Type.String({ minLength: 12, maxLength: 480 }),
  },
  { additionalProperties: false, $id: 'CivicActionUpdateBody' },
);

export const CivicActionUpdateSchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    authorDisplayName: Type.String({ minLength: 1 }),
    text: Type.String({ minLength: 1 }),
    createdAt: Type.String({ format: 'date-time' }),
    isMine: Type.Boolean(),
  },
  { additionalProperties: false, $id: 'CivicActionUpdate' },
);

export const CivicActionResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        processId: Type.String({ format: 'uuid' }),
        currentStage: Type.Union([
          Type.Literal('mandate'),
          Type.Literal('action'),
          Type.Literal('verification'),
          Type.Literal('archived'),
        ]),
        winner: Type.Union([CivicMandateWinnerSchema, Type.Null()]),
        canPost: Type.Boolean(),
        updates: Type.Array(CivicActionUpdateSchema, { maxItems: 200 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'CivicActionResponse' },
);

export const CivicActionUpdateCreatedResponseSchema = Type.Object(
  {
    data: CivicActionUpdateSchema,
  },
  { additionalProperties: false, $id: 'CivicActionUpdateCreatedResponse' },
);

export const CivicActionRouteResponses = {
  read: {
    200: CivicActionResponseSchema,
    400: DomainErrorResponseSchema,
    404: DomainErrorResponseSchema,
  },
  create: {
    201: CivicActionUpdateCreatedResponseSchema,
    400: DomainErrorResponseSchema,
    401: DomainErrorResponseSchema,
    403: DomainErrorResponseSchema,
    404: DomainErrorResponseSchema,
    409: DomainErrorResponseSchema,
  },
} as const;

export type CivicActionUpdateBody = Static<typeof CivicActionUpdateBodySchema>;

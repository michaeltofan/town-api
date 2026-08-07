import { Type, type Static } from '@sinclair/typebox';
import { CivicMandateWinnerSchema } from './civic-mandate.js';
import { DomainErrorResponseSchema } from './error.js';

export const CivicActionUpdateKindSchema = Type.Union(
  [
    Type.Literal('status_update'),
    Type.Literal('take_step'),
    Type.Literal('offer_help'),
    Type.Literal('evidence'),
    Type.Literal('institution_response'),
  ],
  { $id: 'CivicActionUpdateKind' },
);

export const CivicActionBlockedReasonKeySchema = Type.Union(
  [
    Type.Literal('awaiting_institution_response'),
    Type.Literal('awaiting_resources'),
    Type.Literal('awaiting_volunteers'),
    Type.Literal('other'),
  ],
  { $id: 'CivicActionBlockedReasonKey' },
);

export const CivicActionStatusSchema = Type.Union(
  [
    Type.Literal('not_started'),
    Type.Literal('in_progress'),
    Type.Literal('blocked'),
    Type.Literal('completed'),
  ],
  { $id: 'CivicActionStatus' },
);

export const CivicActionUpdateBodySchema = Type.Object(
  {
    text: Type.String({ minLength: 12, maxLength: 480 }),
    kind: Type.Optional(CivicActionUpdateKindSchema),
    blockedReasonKey: Type.Optional(CivicActionBlockedReasonKeySchema),
    url: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  },
  { additionalProperties: false, $id: 'CivicActionUpdateBody' },
);

export const CivicActionUpdateSchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    authorDisplayName: Type.String({ minLength: 1 }),
    text: Type.String({ minLength: 1 }),
    kind: CivicActionUpdateKindSchema,
    blockedReasonKey: Type.Union([CivicActionBlockedReasonKeySchema, Type.Null()]),
    url: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    createdAt: Type.String({ format: 'date-time' }),
    isMine: Type.Boolean(),
  },
  { additionalProperties: false, $id: 'CivicActionUpdate' },
);

export const CivicActionCollaboratorSchema = Type.Object(
  {
    actorId: Type.String({ format: 'uuid' }),
    displayName: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false, $id: 'CivicActionCollaborator' },
);

const CivicActionActorRefSchema = Type.Object(
  {
    actorId: Type.String({ format: 'uuid' }),
    displayName: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
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
        actionStatus: CivicActionStatusSchema,
        responsibleActor: Type.Union([CivicActionActorRefSchema, Type.Null()]),
        collaborators: Type.Array(CivicActionCollaboratorSchema, { maxItems: 200 }),
        canPost: Type.Boolean(),
        canTakeStep: Type.Boolean(),
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

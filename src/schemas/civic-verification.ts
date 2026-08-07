import { Type, type Static } from '@sinclair/typebox';
import { CivicMandateWinnerSchema } from './civic-mandate.js';
import { DomainErrorResponseSchema } from './error.js';

export const CivicVerificationOutcomeSchema = Type.Union([
  Type.Literal('delivered'),
  Type.Literal('not_delivered'),
]);

export const CivicVerificationEvidenceBodySchema = Type.Object(
  {
    text: Type.String({ minLength: 12, maxLength: 480 }),
    url: Type.Union([Type.String({ format: 'uri', minLength: 1, maxLength: 500 }), Type.Null()]),
  },
  { additionalProperties: false, $id: 'CivicVerificationEvidenceBody' },
);

export const CivicVerificationConfirmationBodySchema = Type.Object(
  {
    outcome: CivicVerificationOutcomeSchema,
  },
  { additionalProperties: false, $id: 'CivicVerificationConfirmationBody' },
);

export const CivicVerificationEvidenceSchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    authorDisplayName: Type.String({ minLength: 1 }),
    text: Type.String({ minLength: 1 }),
    url: Type.Union([Type.String({ format: 'uri' }), Type.Null()]),
    createdAt: Type.String({ format: 'date-time' }),
    isMine: Type.Boolean(),
  },
  { additionalProperties: false, $id: 'CivicVerificationEvidence' },
);

export const CivicVerificationResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        processId: Type.String({ format: 'uuid' }),
        currentStage: Type.Union([
          Type.Literal('action'),
          Type.Literal('verification'),
          Type.Literal('archived'),
        ]),
        winner: Type.Union([CivicMandateWinnerSchema, Type.Null()]),
        canMarkReady: Type.Boolean(),
        canConfirm: Type.Boolean(),
        hasConfirmed: Type.Boolean(),
        myOutcome: Type.Union([CivicVerificationOutcomeSchema, Type.Null()]),
        deliveredCount: Type.Integer({ minimum: 0 }),
        notDeliveredCount: Type.Integer({ minimum: 0 }),
        outcome: Type.Union([CivicVerificationOutcomeSchema, Type.Null()]),
        decidedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
        verificationOpenedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
        disputeEscalatesAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
        disputeEscalated: Type.Boolean(),
        evidence: Type.Array(CivicVerificationEvidenceSchema, { maxItems: 200 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'CivicVerificationResponse' },
);

export const CivicVerificationReadyResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        processId: Type.String({ format: 'uuid' }),
        currentStage: Type.Union([Type.Literal('action'), Type.Literal('verification')]),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'CivicVerificationReadyResponse' },
);

export const CivicVerificationEvidenceCreatedResponseSchema = Type.Object(
  {
    data: CivicVerificationEvidenceSchema,
  },
  { additionalProperties: false, $id: 'CivicVerificationEvidenceCreatedResponse' },
);

export const CivicVerificationConfirmationCreatedResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        outcome: CivicVerificationOutcomeSchema,
        createdAt: Type.String({ format: 'date-time' }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'CivicVerificationConfirmationCreatedResponse' },
);

export const CivicVerificationRouteResponses = {
  read: {
    200: CivicVerificationResponseSchema,
    400: DomainErrorResponseSchema,
    404: DomainErrorResponseSchema,
  },
  ready: {
    200: CivicVerificationReadyResponseSchema,
    400: DomainErrorResponseSchema,
    401: DomainErrorResponseSchema,
    403: DomainErrorResponseSchema,
    404: DomainErrorResponseSchema,
    409: DomainErrorResponseSchema,
  },
  evidence: {
    201: CivicVerificationEvidenceCreatedResponseSchema,
    400: DomainErrorResponseSchema,
    401: DomainErrorResponseSchema,
    403: DomainErrorResponseSchema,
    404: DomainErrorResponseSchema,
    409: DomainErrorResponseSchema,
  },
  confirm: {
    201: CivicVerificationConfirmationCreatedResponseSchema,
    400: DomainErrorResponseSchema,
    401: DomainErrorResponseSchema,
    403: DomainErrorResponseSchema,
    404: DomainErrorResponseSchema,
    409: DomainErrorResponseSchema,
  },
} as const;

export type CivicVerificationEvidenceBody = Static<typeof CivicVerificationEvidenceBodySchema>;
export type CivicVerificationConfirmationBody = Static<
  typeof CivicVerificationConfirmationBodySchema
>;

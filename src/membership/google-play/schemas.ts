import { Type, type Static } from '@sinclair/typebox';
import { DomainErrorResponseSchema } from '../../schemas/error.js';
import { MembershipStatusSchema } from '../schemas.js';

export const GooglePlayPurchaseRequestSchema = Type.Object(
  {
    purchaseToken: Type.String({ minLength: 1, maxLength: 4096 }),
    packageName: Type.Optional(Type.String({ minLength: 3, maxLength: 255 })),
    subscriptionId: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
  },
  { additionalProperties: false, $id: 'GooglePlayPurchaseRequest' },
);

export const GooglePlayPurchaseResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        result: Type.Union([Type.Literal('applied'), Type.Literal('replayed')]),
        membership: Type.Object(
          {
            status: MembershipStatusSchema,
            accessUntil: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
            cancelAtPeriodEnd: Type.Boolean(),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'GooglePlayPurchaseResponse' },
);

export const GooglePlayPurchaseRouteResponses = {
  purchase: {
    200: GooglePlayPurchaseResponseSchema,
    400: DomainErrorResponseSchema,
    401: DomainErrorResponseSchema,
    403: DomainErrorResponseSchema,
    409: DomainErrorResponseSchema,
    429: DomainErrorResponseSchema,
    502: DomainErrorResponseSchema,
    503: DomainErrorResponseSchema,
  },
} as const;

export type GooglePlayPurchaseRequest = Static<typeof GooglePlayPurchaseRequestSchema>;
export type GooglePlayPurchaseResponse = Static<typeof GooglePlayPurchaseResponseSchema>;

import { Type, type Static } from '@sinclair/typebox';
import { DomainErrorResponseSchema } from '../schemas/signals.js';
import { ErrorResponseSchema } from '../schemas/error.js';

export const EmptyBodySchema = Type.Object(
  {},
  { additionalProperties: false, $id: 'BillingEmptyBody' },
);

export const CheckoutSessionResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        checkoutUrl: Type.String({ format: 'uri', minLength: 1 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'BillingCheckoutSessionResponse' },
);

export const PortalSessionResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        portalUrl: Type.String({ format: 'uri', minLength: 1 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'BillingPortalSessionResponse' },
);

export const WebhookResponseSchema = Type.Object(
  {
    received: Type.Boolean(),
  },
  { additionalProperties: false, $id: 'BillingWebhookResponse' },
);

export const BillingRouteResponses = {
  checkoutSession: {
    200: CheckoutSessionResponseSchema,
    400: ErrorResponseSchema,
    401: DomainErrorResponseSchema,
    403: DomainErrorResponseSchema,
    409: DomainErrorResponseSchema,
    429: DomainErrorResponseSchema,
    502: DomainErrorResponseSchema,
    503: DomainErrorResponseSchema,
  },
  portalSession: {
    200: PortalSessionResponseSchema,
    400: ErrorResponseSchema,
    401: DomainErrorResponseSchema,
    403: DomainErrorResponseSchema,
    404: DomainErrorResponseSchema,
    429: DomainErrorResponseSchema,
    502: DomainErrorResponseSchema,
    503: DomainErrorResponseSchema,
  },
  webhook: {
    200: WebhookResponseSchema,
    400: ErrorResponseSchema,
    503: DomainErrorResponseSchema,
  },
} as const;

export type CheckoutSessionResponse = Static<typeof CheckoutSessionResponseSchema>;
export type PortalSessionResponse = Static<typeof PortalSessionResponseSchema>;
export type WebhookResponse = Static<typeof WebhookResponseSchema>;

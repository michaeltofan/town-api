import { Type, type Static } from '@sinclair/typebox';

/** API-wide error envelope for all 4xx/5xx responses. */
export const DomainErrorResponseSchema = Type.Object(
  {
    error: Type.Object(
      {
        code: Type.String(),
        message: Type.String(),
        requestId: Type.String(),
      },
      { additionalProperties: false },
    ),
  },
  {
    additionalProperties: false,
    $id: 'DomainErrorResponse',
  },
);

export type DomainErrorResponse = Static<typeof DomainErrorResponseSchema>;

/** Stable machine codes for non-AppError failures mapped by the global error handler. */
export const ERROR_CODE = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  MALFORMED_REQUEST: 'MALFORMED_REQUEST',
  NOT_FOUND: 'NOT_FOUND',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  BAD_REQUEST: 'BAD_REQUEST',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type FrameworkErrorCode = (typeof ERROR_CODE)[keyof typeof ERROR_CODE];

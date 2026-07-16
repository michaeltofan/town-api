import { Type, type Static } from '@sinclair/typebox';

export const ErrorResponseSchema = Type.Object(
  {
    statusCode: Type.Integer({ minimum: 400, maximum: 599 }),
    error: Type.String(),
    message: Type.String(),
    requestId: Type.String(),
  },
  {
    additionalProperties: false,
    $id: 'ErrorResponse',
  },
);

export type ErrorResponse = Static<typeof ErrorResponseSchema>;

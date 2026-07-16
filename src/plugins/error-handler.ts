import type { FastifyError, FastifyPluginCallback } from 'fastify';
import fp from 'fastify-plugin';
import type { ErrorResponse } from '../schemas/error.js';

function toSafeErrorBody(
  statusCode: number,
  error: string,
  message: string,
  requestId: string,
): ErrorResponse {
  return {
    statusCode,
    error,
    message,
    requestId,
  };
}

const errorHandlerPlugin: FastifyPluginCallback = (app, _opts, done) => {
  app.setNotFoundHandler((request, reply) => {
    const body = toSafeErrorBody(404, 'Not Found', 'Not Found', request.id);
    void reply.status(404).type('application/json; charset=utf-8').send(body);
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode =
      typeof error.statusCode === 'number' && error.statusCode >= 400 ? error.statusCode : 500;

    const isClientError = statusCode >= 400 && statusCode < 500;
    const errorName =
      isClientError && error.name.length > 0
        ? error.name
        : isClientError
          ? 'Bad Request'
          : 'Internal Server Error';
    const message =
      isClientError && error.message.length > 0
        ? error.message
        : isClientError
          ? 'Bad Request'
          : 'Internal Server Error';

    if (!isClientError) {
      request.log.error({ err: error, requestId: request.id }, 'Unhandled error');
    }

    const body = toSafeErrorBody(statusCode, errorName, message, request.id);
    void reply.status(statusCode).type('application/json; charset=utf-8').send(body);
  });

  done();
};

export default fp(errorHandlerPlugin, {
  name: 'error-handler',
});

import type { FastifyError, FastifyPluginCallback } from 'fastify';
import fp from 'fastify-plugin';

type PublicClientError = {
  statusCode: number;
  error: string;
  message: string;
  requestId: string;
};

type PublicInternalError = {
  error: {
    code: 'INTERNAL_ERROR';
    message: 'An unexpected error occurred.';
    requestId: string;
  };
};

function toClientErrorBody(
  statusCode: number,
  error: string,
  message: string,
  requestId: string,
): PublicClientError {
  return {
    statusCode,
    error,
    message,
    requestId,
  };
}

function toInternalErrorBody(requestId: string): PublicInternalError {
  return {
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred.',
      requestId,
    },
  };
}

const errorHandlerPlugin: FastifyPluginCallback = (app, _opts, done) => {
  app.setNotFoundHandler((request, reply) => {
    const body = toClientErrorBody(404, 'Not Found', 'Not Found', request.id);
    void reply.status(404).type('application/json; charset=utf-8').send(body);
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode =
      typeof error.statusCode === 'number' && error.statusCode >= 400 ? error.statusCode : 500;

    const isClientError = statusCode >= 400 && statusCode < 500;

    if (!isClientError) {
      request.log.error({ err: error, requestId: request.id }, 'Unhandled error');
      const body = toInternalErrorBody(request.id);
      void reply.status(500).type('application/json; charset=utf-8').send(body);
      return;
    }

    const errorName = error.name.length > 0 ? error.name : 'Bad Request';
    const message = error.message.length > 0 ? error.message : 'Bad Request';
    const body = toClientErrorBody(statusCode, errorName, message, request.id);
    void reply.status(statusCode).type('application/json; charset=utf-8').send(body);
  });

  done();
};

export default fp(errorHandlerPlugin, {
  name: 'error-handler',
});

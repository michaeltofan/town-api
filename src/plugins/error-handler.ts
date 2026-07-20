import type { FastifyError, FastifyPluginCallback } from 'fastify';
import fp from 'fastify-plugin';
import { AppError } from '../errors/app-error.js';
import { ERROR_CODE } from '../schemas/error.js';

type PublicDomainError = {
  error: {
    code: string;
    message: string;
    requestId: string;
  };
};

function toDomainErrorBody(code: string, message: string, requestId: string): PublicDomainError {
  return {
    error: {
      code,
      message,
      requestId,
    },
  };
}

function sendDomainError(
  reply: { status: (code: number) => { type: (t: string) => { send: (body: unknown) => unknown } } },
  statusCode: number,
  code: string,
  message: string,
  requestId: string,
): void {
  const body = toDomainErrorBody(code, message, requestId);
  void reply.status(statusCode).type('application/json; charset=utf-8').send(body);
}

/**
 * Map Fastify / framework errors onto stable domain codes.
 * Messages are fixed safe strings — never stacks, never request payloads.
 */
function mapFrameworkError(error: FastifyError): {
  statusCode: number;
  code: string;
  message: string;
} {
  const statusCode =
    typeof error.statusCode === 'number' && error.statusCode >= 400 ? error.statusCode : 500;
  const fastifyCode = typeof error.code === 'string' ? error.code : '';

  if (statusCode >= 500) {
    return {
      statusCode: 500,
      code: ERROR_CODE.INTERNAL_ERROR,
      message: 'An unexpected error occurred.',
    };
  }

  if (
    fastifyCode === 'FST_ERR_VALIDATION' ||
    (statusCode === 400 && Array.isArray(error.validation))
  ) {
    return {
      statusCode: 400,
      code: ERROR_CODE.VALIDATION_ERROR,
      message: 'Request validation failed.',
    };
  }

  if (
    fastifyCode === 'FST_ERR_CTP_INVALID_JSON_BODY' ||
    fastifyCode === 'FST_ERR_CTP_EMPTY_JSON_BODY' ||
    fastifyCode === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' ||
    fastifyCode === 'FST_ERR_CTP_INVALID_CONTENT_LENGTH'
  ) {
    return {
      statusCode: statusCode >= 400 && statusCode < 500 ? statusCode : 400,
      code: ERROR_CODE.MALFORMED_REQUEST,
      message: 'Malformed request.',
    };
  }

  if (fastifyCode === 'FST_ERR_CTP_BODY_TOO_LARGE' || statusCode === 413) {
    return {
      statusCode: 413,
      code: ERROR_CODE.PAYLOAD_TOO_LARGE,
      message: 'Request body is too large.',
    };
  }

  if (fastifyCode === 'FST_ERR_NOT_FOUND' || statusCode === 404) {
    return {
      statusCode: 404,
      code: ERROR_CODE.NOT_FOUND,
      message: 'Not Found.',
    };
  }

  if (statusCode >= 400 && statusCode < 500) {
    return {
      statusCode,
      code: ERROR_CODE.BAD_REQUEST,
      message: 'Bad Request.',
    };
  }

  return {
    statusCode: 500,
    code: ERROR_CODE.INTERNAL_ERROR,
    message: 'An unexpected error occurred.',
  };
}

const errorHandlerPlugin: FastifyPluginCallback = (app, _opts, done) => {
  app.setNotFoundHandler((request, reply) => {
    sendDomainError(reply, 404, ERROR_CODE.NOT_FOUND, 'Not Found.', request.id);
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof AppError) {
      sendDomainError(reply, error.statusCode, error.code, error.message, request.id);
      return;
    }

    const mapped = mapFrameworkError(error);
    if (mapped.statusCode >= 500) {
      request.log.error({ err: error, requestId: request.id }, 'Unhandled error');
    }
    sendDomainError(reply, mapped.statusCode, mapped.code, mapped.message, request.id);
  });

  done();
};

export default fp(errorHandlerPlugin, {
  name: 'error-handler',
});

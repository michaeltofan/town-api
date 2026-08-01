import type { FastifyError, FastifyPluginCallback } from 'fastify';
import fp from 'fastify-plugin';
import { AppError } from '../errors/app-error.js';
import { ERROR_CODE } from '../schemas/error.js';
import {
  sanitizeTechnicalErrorMessage,
  sanitizeTechnicalErrorName,
  sanitizeTechnicalErrorRoute,
  shouldRecordTechnicalError,
} from '../platform/services/technical-error-sanitize.js';

type PublicDomainError = {
  error: {
    code: string;
    message: string;
    requestId: string;
  };
};

export type TechnicalErrorRecordInput = {
  readonly occurredAt: string;
  readonly requestId: string;
  readonly method: string | null;
  readonly route: string | null;
  readonly statusCode: number;
  readonly errorCode: string;
  readonly errorName: string | null;
  readonly message: string;
};

export type ErrorHandlerPluginOptions = {
  readonly recordTechnicalError?: (input: TechnicalErrorRecordInput) => void | Promise<void>;
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
  reply: {
    status: (code: number) => { type: (t: string) => { send: (body: unknown) => unknown } };
  },
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

function queueTechnicalErrorRecord(
  record: ErrorHandlerPluginOptions['recordTechnicalError'],
  input: TechnicalErrorRecordInput,
): void {
  if (!record) return;
  try {
    void Promise.resolve(record(input)).catch(() => {
      // Recording must never interfere with the client error response.
    });
  } catch {
    // ignore sync recorder failures
  }
}

const errorHandlerPlugin: FastifyPluginCallback<ErrorHandlerPluginOptions> = (app, opts, done) => {
  app.setNotFoundHandler((request, reply) => {
    sendDomainError(reply, 404, ERROR_CODE.NOT_FOUND, 'Not Found.', request.id);
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const routeContext: {
      method?: string;
      routerPath?: string;
      url?: string;
    } = {
      method: request.method,
      url: request.url,
    };
    if (typeof request.routeOptions.url === 'string') {
      routeContext.routerPath = request.routeOptions.url;
    }

    if (error instanceof AppError) {
      if (
        shouldRecordTechnicalError({
          statusCode: error.statusCode,
          ...routeContext,
        })
      ) {
        const { method, route } = sanitizeTechnicalErrorRoute(routeContext);
        queueTechnicalErrorRecord(opts.recordTechnicalError, {
          occurredAt: new Date().toISOString(),
          requestId: request.id,
          method,
          route,
          statusCode: error.statusCode,
          errorCode: error.code,
          errorName: sanitizeTechnicalErrorName(error.name),
          message: sanitizeTechnicalErrorMessage(error.message),
        });
      }
      sendDomainError(reply, error.statusCode, error.code, error.message, request.id);
      return;
    }

    const mapped = mapFrameworkError(error);
    if (mapped.statusCode >= 500) {
      request.log.error({ err: error, requestId: request.id }, 'Unhandled error');
      if (
        shouldRecordTechnicalError({
          statusCode: mapped.statusCode,
          ...routeContext,
        })
      ) {
        const { method, route } = sanitizeTechnicalErrorRoute(routeContext);
        queueTechnicalErrorRecord(opts.recordTechnicalError, {
          occurredAt: new Date().toISOString(),
          requestId: request.id,
          method,
          route,
          statusCode: mapped.statusCode,
          errorCode: mapped.code,
          errorName: sanitizeTechnicalErrorName(error.name),
          // Persist the safe public message, not raw Error.message (may contain secrets).
          message: mapped.message,
        });
      }
    }
    sendDomainError(reply, mapped.statusCode, mapped.code, mapped.message, request.id);
  });

  done();
};

export default fp(errorHandlerPlugin, {
  name: 'error-handler',
});

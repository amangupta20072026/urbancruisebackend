/**
 * Final middleware: turns any error into the standard error envelope.
 * AppError uses its own status and code; anything else is a 500 whose
 * details are hidden in production. 5xx and bugs log at error, 4xx at warn.
 */
import type { ErrorRequestHandler } from 'express';
import { ENV } from '../../../config/env.js';
import { AppError, RateLimitError } from '../../errors/index.js';
import { logger } from '../../logger/index.js';
import type { ErrorEnvelope } from '../../types/api.js';

/**
 * Maps body-parser errors (bad JSON, too large, bad encoding) to 4xx
 * AppErrors so client mistakes are not reported as 500s.
 */
function normaliseBodyParserError(err: unknown): unknown {
  if (err === null || typeof err !== 'object') return err;
  const e = err as { type?: unknown; status?: unknown; expose?: unknown };
  if (typeof e.type !== 'string' || typeof e.status !== 'number') return err;
  if (e.status < 400 || e.status > 499 || e.expose !== true) return err;

  switch (e.type) {
    case 'entity.parse.failed':
      return new AppError({
        statusCode: 400,
        code: 'INVALID_JSON',
        message: 'Request body is not valid JSON.',
        cause: err,
      });
    case 'entity.too.large':
      return new AppError({
        statusCode: 413,
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Request body is too large.',
        cause: err,
      });
    case 'encoding.unsupported':
    case 'charset.unsupported':
      return new AppError({
        statusCode: 415,
        code: 'UNSUPPORTED_ENCODING',
        message: 'Request body encoding is not supported.',
        cause: err,
      });
    default:
      return new AppError({
        statusCode: e.status,
        code: 'BAD_REQUEST',
        message: 'The request body could not be read.',
        cause: err,
      });
  }
}

export const errorHandler: ErrorRequestHandler = (rawErr, req, res, _next) => {
  const err = normaliseBodyParserError(rawErr);
  const isAppError = err instanceof AppError;
  const statusCode = isAppError ? err.statusCode : 500;
  const code = isAppError ? err.code : 'SERVER_ERROR';
  const message = isAppError
    ? err.message
    : ENV.isProd
      ? 'An unexpected error occurred.'
      : (err as Error).message;

  const isOperational = isAppError ? err.isOperational : false;
  const requestId = String(req.id);
  // If headers were already sent, log the status the client actually got.
  const logPayload = res.headersSent
    ? { err, requestId, statusCode, code, headersSent: true, sentStatusCode: res.statusCode }
    : { err, requestId, statusCode, code };

  if (statusCode >= 500 || !isOperational) {
    logger.error(logPayload, 'unhandled request error');
  } else if (statusCode >= 400) {
    logger.warn(logPayload, 'request rejected');
  }

  const envelope: ErrorEnvelope = {
    error: {
      code,
      message,
      requestId,
      ...(isAppError && err.details !== undefined ? { details: err.details } : {}),
    },
  };

  // Response already started: it cannot be completed, so close the socket.
  // Not passed to next(err) because Express would print an unredacted stack.
  if (res.headersSent) {
    req.socket.destroy();
    return;
  }

  if (err instanceof RateLimitError && err.retryAfter !== undefined) {
    res.setHeader('Retry-After', String(err.retryAfter));
  }

  res.status(statusCode).json(envelope);
};

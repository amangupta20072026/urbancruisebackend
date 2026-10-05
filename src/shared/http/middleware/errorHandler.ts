/**
 * ==============================================================================
 * errorHandler — the FINAL middleware
 * ==============================================================================
 * Every path ends here. Rules:
 *   1. `AppError` → its own statusCode + code + message + optional details.
 *   2. Anything else → 500 SERVER_ERROR. Stack logged, never returned.
 *   3. Log level: error for 5xx / non-operational; warn for 4xx.
 *   4. Includes the request-id so support can find the log line.
 *   5. RateLimitError with `retryAfter` → emits standard Retry-After header.
 *   6. Body-parser rejections (bad JSON, body too large, bad encoding) are
 *      CLIENT errors → mapped to 400/413/415 AppErrors first (audit fix #15).
 *      Before, malformed JSON surfaced as a 500 SERVER_ERROR and an
 *      error-level "unhandled" log line — paging on-call for client typos.
 * ==============================================================================
 */
import type { ErrorRequestHandler } from 'express';
import { ENV } from '../../../config/env.js';
import { AppError, RateLimitError } from '../../errors/index.js';
import { logger } from '../../logger/index.js';
import type { ErrorEnvelope } from '../../types/api.js';

/**
 * Express's body parsers throw plain Errors tagged with `type`, `status` and
 * `expose`. Translate the ones we know into AppErrors so they get the right
 * status, a stable code, and warn-level (not error-level) logging.
 * Anything else is returned unchanged.
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
  const logPayload = { err, requestId, statusCode, code };

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

  if (res.headersSent) return; // response already partially written — bail.

  // Standard header for 429 responses that carry a hint. Only set when the
  // value is known — spec allows either seconds or an HTTP-date; we always
  // emit integer seconds.
  if (err instanceof RateLimitError && err.retryAfter !== undefined) {
    res.setHeader('Retry-After', String(err.retryAfter));
  }

  res.status(statusCode).json(envelope);
};

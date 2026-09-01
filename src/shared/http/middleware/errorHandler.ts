/**
 * ==============================================================================
 * errorHandler — the FINAL middleware
 * ==============================================================================
 * Every path ends here. Rules:
 *   1. `AppError` → its own statusCode + code + message + optional details.
 *   2. Anything else → 500 SERVER_ERROR. Stack logged, never returned.
 *   3. Log level: error for 5xx / non-operational; warn for 4xx.
 *   4. Includes the request-id so support can find the log line.
 * ==============================================================================
 */
import type { ErrorRequestHandler } from 'express';
import { ENV } from '../../../config/env.js';
import { AppError } from '../../errors/index.js';
import { logger } from '../../logger/index.js';
import type { ErrorEnvelope } from '../../types/api.js';

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
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
  res.status(statusCode).json(envelope);
};

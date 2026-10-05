/**
 * ==============================================================================
 * requestId middleware
 * ==============================================================================
 * Guarantees every request has `req.id` set BEFORE any other middleware runs.
 * pino-http would also do this, but making it a dedicated middleware means
 * downstream code can rely on `req.id` even if logging is disabled.
 * ==============================================================================
 */
import type { RequestHandler } from 'express';
import { HEADER_REQUEST_ID } from '../../../config/constants.js';
import { resolveRequestId } from '../../utils/request-id.js';

export const requestId: RequestHandler = (req, res, next) => {
  // Caller-supplied ids are kept only if they are safe (audit fix #16) —
  // see shared/utils/request-id.ts.
  const id = resolveRequestId(req.header(HEADER_REQUEST_ID));
  // pino-http types req.id as string | number | object. We always use string.
  (req as unknown as { id: string }).id = id;
  res.setHeader('X-Request-Id', id);
  next();
};

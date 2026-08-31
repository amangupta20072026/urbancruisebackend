/**
 * ==============================================================================
 * requestId middleware
 * ==============================================================================
 * Guarantees every request has `req.id` set BEFORE any other middleware runs.
 * pino-http would also do this, but making it a dedicated middleware means
 * downstream code can rely on `req.id` even if logging is disabled.
 * ==============================================================================
 */
import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { HEADER_REQUEST_ID } from '../../../config/constants.js';

export const requestId: RequestHandler = (req, res, next) => {
  const inbound = req.header(HEADER_REQUEST_ID);
  const id = inbound && inbound.length > 0 ? inbound : randomUUID();
  // pino-http types req.id as string | number | object. We always use string.
  (req as unknown as { id: string }).id = id;
  res.setHeader('X-Request-Id', id);
  next();
};

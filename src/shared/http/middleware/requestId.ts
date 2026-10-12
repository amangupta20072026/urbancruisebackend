/**
 * Sets req.id and the X-Request-Id response header. A client-sent id is
 * reused only if it is safe (see shared/utils/request-id.ts).
 */
import type { RequestHandler } from 'express';
import { HEADER_REQUEST_ID } from '../../../config/constants.js';
import { resolveRequestId } from '../../utils/request-id.js';

export const requestId: RequestHandler = (req, res, next) => {
  const id = resolveRequestId(req.header(HEADER_REQUEST_ID));
  // pino-http types req.id loosely; here it is always a string.
  (req as unknown as { id: string }).id = id;
  res.setHeader('X-Request-Id', id);
  next();
};

/**
 * ==============================================================================
 * notFound — catch-all 404 for unmatched routes
 * ==============================================================================
 * Mounted LAST, before errorHandler. Everything that reaches here is a
 * legitimate 404 — no route handler matched.
 * ==============================================================================
 */
import type { RequestHandler } from 'express';
import { NotFoundError } from '../../errors/index.js';

export const notFound: RequestHandler = (req, _res, next) => {
  next(new NotFoundError(`No route matches ${req.method} ${req.originalUrl}.`, 'ROUTE_NOT_FOUND'));
};

// 404 for any request that no route matched. Mounted after all routes.
import type { RequestHandler } from 'express';
import { NotFoundError } from '../../errors/index.js';
import { redactUrl } from '../../logger/redactUrl.js';

export const notFound: RequestHandler = (req, _res, next) => {
  next(
    new NotFoundError(
      `No route matches ${req.method} ${redactUrl(req.originalUrl)}.`,
      'ROUTE_NOT_FOUND',
    ),
  );
};

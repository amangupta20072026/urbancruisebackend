/**
 * ==============================================================================
 * asyncHandler — legacy wrap-async-and-catch helper
 * ==============================================================================
 * Express 5 auto-catches rejected promises from async route handlers, so most
 * code no longer needs this. Keep it here for the rare case of a callback-style
 * handler that needs to forward a caught error to `next`.
 * ==============================================================================
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

export const asyncHandler =
  (fn: AsyncHandler): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

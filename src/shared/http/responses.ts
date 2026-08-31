/**
 * ==============================================================================
 * Response helpers — uniform envelopes
 * ==============================================================================
 * Controllers call `ok(res, data)` / `created(res, data)` / etc. so every
 * successful response wraps in the same envelope, and the request-id is
 * always attached without controllers thinking about it.
 * ==============================================================================
 */
import type { Request, Response } from 'express';
import type { ApiResponse, Paginated } from '../types/api.js';
import { ForbiddenError } from '../errors/index.js';
import type { Identity } from '../types/identity.js';

export function ok<T>(res: Response, data: T): Response {
  const req = res.req as Request;
  const body: ApiResponse<T> = { data, requestId: String(req.id) };
  return res.status(200).json(body);
}

export function created<T>(res: Response, data: T): Response {
  const req = res.req as Request;
  const body: ApiResponse<T> = { data, requestId: String(req.id) };
  return res.status(201).json(body);
}

export function noContent(res: Response): Response {
  return res.status(204).end();
}

export function paginated<T>(
  res: Response,
  data: T[],
  page: number,
  pageSize: number,
  total: number,
): Response {
  const req = res.req as Request;
  const body: Paginated<T> = {
    data,
    page,
    pageSize,
    total,
    hasNext: page * pageSize < total,
    requestId: String(req.id),
  };
  return res.status(200).json(body);
}

/**
 * Fetch req.identity with a runtime assertion. Any route calling this MUST
 * have `authenticate` upstream. If it doesn't, this throws ForbiddenError
 * rather than returning undefined — clearer failure mode than a silent bug.
 */
export function getIdentity(req: Request): Identity {
  if (!req.identity) throw new ForbiddenError('Not authenticated.', 'AUTH_UNAUTHENTICATED');
  return req.identity;
}

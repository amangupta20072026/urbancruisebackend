/**
 * Success response helpers. Every response uses the same envelope and
 * includes the request id.
 */
import type { Request, Response } from 'express';
import type { ApiResponse, PageMeta, Paginated } from '../types/api.js';
import { ForbiddenError } from '../errors/index.js';
import type { Identity } from '../types/identity.js';

/**
 * Returns a 200 OK response with the given data in the standard envelope.
 * @param res The Express response object.
 * @param data The data to send in the response body.
 */
export function ok<T>(res: Response, data: T): Response {
  const req = res.req as Request;
  const body: ApiResponse<T> = { data, requestId: String(req.id) };
  return res.status(200).json(body);
}

/**
 * Returns a 201 Created response with the given data in the standard envelope.
 * @param res The Express response object.
 * @param data The data to send in the response body.
 */
export function created<T>(res: Response, data: T): Response {
  const req = res.req as Request;
  const body: ApiResponse<T> = { data, requestId: String(req.id) };
  return res.status(201).json(body);
}

export function noContent(res: Response): Response {
  return res.status(204).end();
}

/**
 * Paginated list response. meta (e.g. unread count) is included only when
 * provided.
 */
export function paginated<T>(
  res: Response,
  data: T[],
  page: number,
  pageSize: number,
  total: number,
  meta?: PageMeta,
): Response {
  const req = res.req as Request;
  const body: Paginated<T> = {
    data,
    page,
    pageSize,
    total,
    hasNext: page * pageSize < total,
    ...(meta !== undefined ? { meta } : {}),
    requestId: String(req.id),
  };
  return res.status(200).json(body);
}

/**
 * Returns req.identity. The route must use authenticate; if it doesn't,
 * this throws instead of returning undefined.
 */
export function getIdentity(req: Request): Identity {
  if (!req.identity) throw new ForbiddenError('Not authenticated.', 'AUTH_UNAUTHENTICATED');
  return req.identity;
}

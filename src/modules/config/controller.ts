/**
 * ==============================================================================
 * config — controller (HTTP glue only)
 * ==============================================================================
 * Reads validated query params, calls the service, sends the response with
 * appropriate cache headers. Handles 304 Not Modified when the client's
 * `If-None-Match` matches our current ETag.
 * ==============================================================================
 */
import type { Request, Response } from 'express';
import { ok } from '../../shared/http/responses.js';
import * as service from './service.js';
import type { AppConfigQuery } from './schemas.js';

export async function getAppConfig(req: Request, res: Response): Promise<Response> {
  const q = req.query as unknown as AppConfigQuery;

  const { data, etag } = await service.getAppConfig({
    platform: q.platform,
    appVersion: q.appVersion,
    buildNumber: q.buildNumber ?? null,
    locale: q.locale ?? null,
  });

  // Cache policy — public because there's no per-user data in the payload
  // (the response varies by appVersion but the ETag captures that).
  //   fresh   → 60s  ("public, max-age=60")
  //   stale   → 300s served while revalidating
  // Vary by URL only (query strings are part of the cache key automatically).
  res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
  res.setHeader('ETag', etag);

  // Conditional GET short-circuit — save bandwidth on the common case.
  const ifNoneMatch = req.header('if-none-match');
  if (ifNoneMatch && ifNoneMatch === etag) {
    return res.status(304).end();
  }

  return ok(res, data);
}

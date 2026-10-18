/**
 * config controller. Both endpoints are public and cacheable: they set
 * Cache-Control and ETag, and answer 304 when If-None-Match matches.
 */
import type { Request, Response } from 'express';
import { ok } from '../../shared/http/responses.js';
import * as service from './service.js';
import type { AppConfigQuery } from './schemas.js';

// Brochures change only on a backend deploy. Short max-age so an update
// reaches clients within minutes; the ETag makes revalidation cheap.
const BROCHURES_CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=300';

export async function getAppConfig(req: Request, res: Response): Promise<Response> {
  const q = req.query as unknown as AppConfigQuery;

  const { data, etag } = await service.getAppConfig({
    platform: q.platform,
    appVersion: q.appVersion,
    buildNumber: q.buildNumber ?? null,
    locale: q.locale ?? null,
  });

  // Public: no per-user data. The query string is part of the cache key.
  res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
  res.setHeader('ETag', etag);

  const ifNoneMatch = req.header('if-none-match');
  if (ifNoneMatch && ifNoneMatch === etag) {
    return res.status(304).end();
  }

  return ok(res, data);
}

export async function getBrochures(req: Request, res: Response): Promise<Response> {
  const { data, etag } = await service.getBrochures();

  // Public: the same catalog for every caller.
  res.setHeader('Cache-Control', BROCHURES_CACHE_CONTROL);
  res.setHeader('ETag', etag);

  const ifNoneMatch = req.header('if-none-match');
  if (ifNoneMatch && ifNoneMatch === etag) {
    return res.status(304).end();
  }

  return ok(res, data);
}

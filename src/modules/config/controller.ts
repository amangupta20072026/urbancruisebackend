/** config controller. Sets cache headers and answers 304 when the ETag matches. */
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

  // Public: no per-user data. The query string is part of the cache key.
  res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
  res.setHeader('ETag', etag);

  const ifNoneMatch = req.header('if-none-match');
  if (ifNoneMatch && ifNoneMatch === etag) {
    return res.status(304).end();
  }

  return ok(res, data);
}

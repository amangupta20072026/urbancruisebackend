/**
 * ==============================================================================
 * security middleware — Helmet + power-header off + trust proxy
 * ==============================================================================
 * `trust proxy` is applied here (not on the express app) so it's co-located
 * with the security concern. Nginx sets X-Forwarded-For; we trust exactly
 * TRUST_PROXY_HOPS hops.
 * ==============================================================================
 */
import type { Express, RequestHandler } from 'express';
import helmet from 'helmet';
import { ENV } from '../../../config/env.js';

/** Apply app-level security settings (called once from app.ts). */
export function applySecurity(app: Express): void {
  app.disable('x-powered-by');
  app.set('trust proxy', ENV.TRUST_PROXY_HOPS);
}

/** Middleware stack to mount early in the pipeline. */
export const securityMiddleware: RequestHandler = helmet({
  contentSecurityPolicy: false, // API-only — no HTML to protect
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  strictTransportSecurity: {
    // Nginx also sets HSTS. This is belt-and-braces.
    maxAge: 63_072_000, // 2 years
    includeSubDomains: true,
    preload: true,
  },
});

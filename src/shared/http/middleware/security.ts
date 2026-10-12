// Security headers (Helmet) and app-level security settings.
import type { Express, RequestHandler } from 'express';
import helmet from 'helmet';
import { ENV } from '../../../config/env.js';

/** Hides x-powered-by and trusts TRUST_PROXY_HOPS proxies for client IPs. */
export function applySecurity(app: Express): void {
  app.disable('x-powered-by');
  app.set('trust proxy', ENV.TRUST_PROXY_HOPS);
}

export const securityMiddleware: RequestHandler = helmet({
  contentSecurityPolicy: false, // JSON API, no HTML pages
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  strictTransportSecurity: {
    maxAge: 63_072_000, // 2 years
    includeSubDomains: true,
    preload: true,
  },
});

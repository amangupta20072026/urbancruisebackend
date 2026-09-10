/**
 * ==============================================================================
 * buildApp — Express instance + middleware pipeline (ORDER MATTERS)
 * ==============================================================================
 * Every step of the pipeline is intentional. Adding middleware later — put it
 * in the RIGHT position or something silently breaks. The order is:
 *
 *   1. Security         — Helmet, x-powered-by off, trust proxy
 *   2. requestId        — attach req.id (used by everyone downstream)
 *   3. requestContext   — AsyncLocalStorage store (id + identity available anywhere)
 *   4. httpLogger       — 1 structured log line per request, includes req.id
 *   5. CORS             — before body parsers so preflight is fast
 *   6. Body parsers     — express.json / express.urlencoded (v5 built-in)
 *   7. Rate limit       — after body parsers so we don't block valid low-cost 405s
 *                          but before route handlers so buckets are respected
 *   8. Modules          — health, then business modules
 *   9. notFound         — catch-all 404
 *  10. errorHandler     — final AppError → HTTP envelope
 * ==============================================================================
 */
import express, { type Express } from 'express';

import { JSON_BODY_LIMIT, URLENCODED_BODY_LIMIT } from './config/constants.js';

import { applySecurity, securityMiddleware } from './shared/http/middleware/security.js';
import { requestId } from './shared/http/middleware/requestId.js';
import { requestContext } from './shared/http/middleware/requestContext.js';
import { httpLogger } from './shared/http/middleware/httpLogger.js';
import { globalRateLimit } from './shared/http/middleware/rateLimit.js';
import { notFound } from './shared/http/middleware/notFound.js';
import { errorHandler } from './shared/http/middleware/errorHandler.js';

// Modules
import healthModule from './modules/health/index.js';
import authModule from './modules/auth/index.js';
import configModule from './modules/config/index.js';

export function buildApp(): Express {
  const app = express();

  // 1. App-level security settings
  applySecurity(app);

  // 2-4. Request-scoped infra (id → context → log)
  app.use(requestId);
  app.use(requestContext);
  app.use(httpLogger);

  // Security middleware runs early so headers are always set even on 4xx.
  app.use(securityMiddleware);

  // 5. CORS is currently not required as the API is consumed exclusively by native mobile clients.
  // Enable CORS when browser-based/web clients are supported.

  //  app.use(corsMiddleware);

  // 6. Body parsers (Express 5 built-in)
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  app.use(express.urlencoded({ extended: true, limit: URLENCODED_BODY_LIMIT }));

  // 7. Global rate limit (per-route limiters can layer on top)
  app.use(globalRateLimit);

  // 8. Modules
  //    Every module exports `mount(): Router`. Base paths are decided here.
  app.use('/', healthModule.mount()); // /health + /ready
  app.use('/api/v1/auth', authModule.mount());
  app.use('/api/v1/config', configModule.mount()); // /config/app (public — pre-login)

  // TODO(step-2): mount business modules
  // app.use('/api/v1/customer',      customerModule.mount());
  // app.use('/api/v1/vendor',        vendorModule.mount());
  // app.use('/api/v1/driver',        driverModule.mount());
  // app.use('/api/v1/uc',            ucModule.mount());
  // app.use('/api/v1/notifications', notificationsModule.mount());
  // app.use('/api/v1/support',       supportModule.mount());

  // 9. 404
  app.use(notFound);

  // 10. Error handler MUST be last.
  app.use(errorHandler);

  return app;
}

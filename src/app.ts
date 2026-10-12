/**
 * Builds the Express app. Middleware order is intentional — keep it:
 * security → request id/context/logging → webhooks → body parsers →
 * rate limit → routes → 404 → error handler.
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

import healthModule from './modules/health/index.js';
import authModule, { mountWebhooks as authWebhooks } from './modules/auth/index.js';
import configModule from './modules/config/index.js';
import customerModule from './modules/customer/index.js';
import notificationsModule from './modules/notifications/index.js';

export function buildApp(): Express {
  const app = express();

  // Disable x-powered-by and set trust proxy.
  applySecurity(app);

  // Request id first: the context and logger both use it.
  app.use(requestId);
  app.use(requestContext);
  app.use(httpLogger);

  // Helmet headers, set early so error responses get them too.
  app.use(securityMiddleware);

  // CORS is not enabled: the API is used only by native mobile apps.

  // Webhooks go before the global body parsers and rate limit: they verify
  // their URL token, then parse with a larger limit, and MSG91 sends bursts.
  app.use('/webhooks', authWebhooks());

  // Body parsers for all other routes. The global limit is small to avoid
  // DoS attacks. Each module may have its own larger limit for file uploads.
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  app.use(express.urlencoded({ extended: true, limit: URLENCODED_BODY_LIMIT }));

  // Global rate limit goes before the modules, so it applies to all routes. Each
  // module may also have its own stricter limit for sensitive endpoints.
  app.use(globalRateLimit);

  // Mount the modules. Each module mounts its own routes and middleware.
  app.use('/', healthModule.mount());
  app.use('/api/v1/auth', authModule.mount());
  app.use('/api/v1/config', configModule.mount());
  app.use('/api/v1/customer', customerModule.mount());
  app.use('/api/v1/notifications', notificationsModule.mount());

  // TODO: mount the vendor, driver, uc and support modules once implemented.

  // 404 handler last: it catches requests that didn't match any route.
  app.use(notFound);

  // Error handler last: it catches errors from all previous middleware and routes.
  app.use(errorHandler);

  return app;
}

/**
 * ==============================================================================
 * auth module — public mount
 * ==============================================================================
 * Exposes two routers:
 *   - default.mount() → the user-facing auth API (/api/v1/auth/*)
 *   - mountWebhooks() → provider callbacks (/webhooks/msg91/*). Kept off the
 *     versioned API prefix because MSG91 configures this URL once in their
 *     dashboard; the URL must remain stable across API version bumps.
 * ==============================================================================
 */
import { Router } from 'express';
import routes from './routes.js';
import webhookRoutes from './webhook/routes.js';

export function mountWebhooks(): Router {
  return webhookRoutes;
}

export default {
  mount(): Router {
    return routes;
  },
};

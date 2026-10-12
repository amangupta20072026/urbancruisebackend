/**
 * auth module. mount() serves /api/v1/auth; mountWebhooks() serves the
 * MSG91 callbacks at /webhooks, outside the versioned prefix so the URL
 * configured in MSG91 never changes.
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

/**
 * ==============================================================================
 * config module — public mount
 * ==============================================================================
 * Serves server-driven app configuration (version policy, feature flags,
 * support/legal links, maintenance mode). Called by clients at cold start
 * BEFORE login — do not add auth middleware here.
 * ==============================================================================
 */
import type { Router } from 'express';
import router from './routes.js';

export default {
  mount(): Router {
    return router;
  },
};

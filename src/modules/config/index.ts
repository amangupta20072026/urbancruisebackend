/**
 * config module. Server-driven app config (version policy, flags, links,
 * maintenance). Called at cold start before login, so it has no auth.
 */
import type { Router } from 'express';
import router from './routes.js';

export default {
  mount(): Router {
    return router;
  },
};

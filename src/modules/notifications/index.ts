/**
 * notifications module — public API
 * Exposes mount() for app.ts and sendNotification() for other modules
 * that want to deliver a push without knowing FCM internals.
 */
import { Router } from 'express';
import router from './routes.js';

export { sendNotification } from './service.js';

export default {
  mount(): Router {
    return router;
  },
};

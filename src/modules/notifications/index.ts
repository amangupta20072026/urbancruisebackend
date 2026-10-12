/**
 * notifications module. Other modules notify users with:
 *   await sendNotification(notificationDeps, { role, entityId, kind, ... });
 */
import { Router } from 'express';
import router from './routes.js';

export { sendNotification } from './service.js';
export { notificationDeps } from './infrastructure/NotificationsContainer.js';

export default {
  mount(): Router {
    return router;
  },
};

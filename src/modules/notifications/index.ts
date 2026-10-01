/**
 * notifications module — public API
 *
 * Exposes:
 *   mount()             — Express router for app.ts
 *   sendNotification()  — for other modules that want to deliver a push
 *   notificationDeps    — production deps bundle (pass to sendNotification)
 *
 * USAGE FROM OTHER MODULES:
 *   import { sendNotification, notificationDeps } from '../notifications/index.js';
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

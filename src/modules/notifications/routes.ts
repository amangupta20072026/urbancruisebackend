/**
 * notifications routes, mounted at /api/v1/notifications. All require a session.
 *   POST   /tokens            register FCM token (login, cold start)
 *   DELETE /tokens/:deviceId  unregister (logout)
 *   GET    /                  inbox, paginated
 *   POST   /read-all          mark all read
 *   POST   /:id/read          mark one read
 */
import { Router } from 'express';
import { validate } from '../../shared/http/middleware/validate.js';
import { authenticate } from '../../shared/http/middleware/authenticate.js';
import { authorize } from '../../shared/http/middleware/authorize.js';
import {
  RegisterTokenBody,
  UnregisterTokenParams,
  ListNotificationsQuery,
  NotificationUuidParams,
} from './schemas.js';
import {
  postRegisterToken,
  deleteUnregisterToken,
  getNotifications,
  postMarkRead,
  postMarkAllRead,
} from './controller.js';

const router = Router();

router.use(authenticate);

// Token routes need no authorize(): entityId comes from the JWT, so callers
// can only manage their own tokens.
router.post('/tokens', validate({ body: RegisterTokenBody }), postRegisterToken);

router.delete(
  '/tokens/:deviceId',
  validate({ params: UnregisterTokenParams }),
  deleteUnregisterToken,
);

router.get(
  '/',
  authorize('read', 'Notification'),
  validate({ query: ListNotificationsQuery }),
  getNotifications,
);

// Must be registered before /:id/read.
router.post('/read-all', authorize('read', 'Notification'), postMarkAllRead);

router.post(
  '/:id/read',
  authorize('read', 'Notification'),
  validate({ params: NotificationUuidParams }),
  postMarkRead,
);

export default router;

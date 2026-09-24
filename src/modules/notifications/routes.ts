/**
 * ==============================================================================
 * notifications — routes
 * ==============================================================================
 * All routes require authentication (authenticate middleware).
 * The authorize() middleware enforces the coarse RBAC check — all roles can
 * read and manage their own notifications.
 *
 * Route list:
 *   POST   /notifications/tokens            — register FCM token (login/cold-start)
 *   DELETE /notifications/tokens/:deviceId  — unregister (logout)
 *   GET    /notifications                   — inbox list (paginated)
 *   POST   /notifications/read-all          — mark all read
 *   POST   /notifications/:id/read          — mark one read
 * ==============================================================================
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

// All notification routes require a valid session.
router.use(authenticate);

/**
 * POST /tokens — upsert FCM registration token
 * No authorize() needed beyond authenticate — a user can only register a
 * token for themselves (entityId comes from the JWT, not the request body).
 */
router.post('/tokens', validate({ body: RegisterTokenBody }), postRegisterToken);

/**
 * DELETE /tokens/:deviceId — remove FCM registration token
 */
router.delete(
  '/tokens/:deviceId',
  validate({ params: UnregisterTokenParams }),
  deleteUnregisterToken,
);

/**
 * GET / — notification inbox
 */
router.get(
  '/',
  authorize('read', 'Notification'),
  validate({ query: ListNotificationsQuery }),
  getNotifications,
);

/**
 * POST /read-all — must come BEFORE /:id/read to avoid the wildcard match
 */
router.post('/read-all', authorize('read', 'Notification'), postMarkAllRead);

/**
 * POST /:id/read — mark single notification read
 */
router.post(
  '/:id/read',
  authorize('read', 'Notification'),
  validate({ params: NotificationUuidParams }),
  postMarkRead,
);

export default router;

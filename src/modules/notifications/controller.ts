/**
 * ==============================================================================
 * notifications — controller (HTTP glue only)
 * ==============================================================================
 * NO business logic. Parse validated body/params/query, call service, respond.
 * ==============================================================================
 */
import type { Request, Response } from 'express';
import { noContent, paginated, getIdentity } from '../../shared/http/responses.js';
import * as service from './service.js';
import type {
  RegisterTokenBody,
  UnregisterTokenParams,
  ListNotificationsQuery,
  NotificationUuidParams,
} from './schemas.js';

/**
 * POST /notifications/tokens
 * Register or refresh an FCM token for the authenticated device.
 */
export async function postRegisterToken(req: Request, res: Response): Promise<Response> {
  const identity = getIdentity(req);
  const body = req.body as RegisterTokenBody;

  // exactOptionalPropertyTypes: spread only defined optional fields
  await service.registerToken({
    role: identity.role,
    entityId: Number(identity.entityId),
    deviceId: body.deviceId,
    fcmToken: body.token,
    platform: body.platform,
    ...(body.deviceName !== undefined ? { deviceName: body.deviceName } : {}),
    ...(body.appVersion !== undefined ? { appVersion: body.appVersion } : {}),
  });

  return noContent(res);
}

/**
 * DELETE /notifications/tokens/:deviceId
 * Unregister the FCM token for a specific device. Called on logout.
 */
export async function deleteUnregisterToken(req: Request, res: Response): Promise<Response> {
  const identity = getIdentity(req);
  const params = req.params as unknown as UnregisterTokenParams;

  await service.unregisterToken({
    role: identity.role,
    entityId: Number(identity.entityId),
    deviceId: params.deviceId,
  });

  return noContent(res);
}

/**
 * GET /notifications
 * Paginated notification inbox for the authenticated user.
 *
 * Response (finding M6 — unreadCount used to be computed and then dropped):
 *   { data, page, pageSize, total, hasNext,
 *     meta: { unreadCount }, requestId }
 *
 * `meta.unreadCount` = this user's unread notifications. When the request
 * filters by `category`, the count is for that category only (see
 * repository.listNotifications). It ignores the `unread` filter and the
 * page, so it is the right number for the app's badge.
 */
export async function getNotifications(req: Request, res: Response): Promise<Response> {
  const identity = getIdentity(req);
  const query = req.query as unknown as ListNotificationsQuery;

  // exactOptionalPropertyTypes: only pass optional fields when defined
  const result = await service.listNotifications({
    role: identity.role,
    entityId: Number(identity.entityId),
    page: query.page,
    pageSize: query.pageSize,
    ...(query.category !== undefined ? { category: query.category } : {}),
    ...(query.unread !== undefined ? { unreadOnly: query.unread } : {}),
  });

  return paginated(res, result.items, query.page, query.pageSize, result.total, {
    unreadCount: result.unreadCount,
  });
}

/**
 * POST /notifications/:id/read
 * Mark a specific notification as read.
 */
export async function postMarkRead(req: Request, res: Response): Promise<Response> {
  const identity = getIdentity(req);
  const params = req.params as unknown as NotificationUuidParams;

  await service.markNotificationRead({
    uuid: params.id,
    role: identity.role,
    entityId: Number(identity.entityId),
  });

  return noContent(res);
}

/**
 * POST /notifications/read-all
 * Mark all notifications as read for the authenticated user.
 */
export async function postMarkAllRead(req: Request, res: Response): Promise<Response> {
  const identity = getIdentity(req);

  await service.markAllRead({
    role: identity.role,
    entityId: Number(identity.entityId),
  });

  return noContent(res);
}

/** notifications controller. */
import type { Request, Response } from 'express';
import { noContent, paginated, getIdentity } from '../../shared/http/responses.js';
import * as service from './service.js';
import type {
  RegisterTokenBody,
  UnregisterTokenParams,
  ListNotificationsQuery,
  NotificationUuidParams,
} from './schemas.js';

/** POST /tokens — register or refresh this device's FCM token. */
export async function postRegisterToken(req: Request, res: Response): Promise<Response> {
  const identity = getIdentity(req);
  const body = req.body as RegisterTokenBody;

  // exactOptionalPropertyTypes: pass optional fields only when defined.
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

/** DELETE /tokens/:deviceId — remove a device's token (logout). */
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
 * GET / — paginated inbox. meta.unreadCount is for the app badge: it
 * respects the category filter but ignores the unread filter and paging.
 */
export async function getNotifications(req: Request, res: Response): Promise<Response> {
  const identity = getIdentity(req);
  const query = req.query as unknown as ListNotificationsQuery;

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

/** POST /:id/read — mark one notification read. */
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

/** POST /read-all — mark all read. */
export async function postMarkAllRead(req: Request, res: Response): Promise<Response> {
  const identity = getIdentity(req);

  await service.markAllRead({
    role: identity.role,
    entityId: Number(identity.entityId),
  });

  return noContent(res);
}

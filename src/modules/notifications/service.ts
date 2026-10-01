/**
 * ==============================================================================
 * notifications — service layer
 * ==============================================================================
 * Business logic only. No Express types. No SQL. No Firebase SDK imports.
 *
 * PUBLIC API (consumed by this module's controller):
 *   registerToken        — called on login / cold-start
 *   unregisterToken      — called on logout
 *   listNotifications    — inbox list
 *   markNotificationRead — single read
 *   markAllRead          — bulk read
 *
 * INTERNAL API (consumed by other modules wanting to send a push):
 *   sendNotification     — create + persist + push in one call
 *
 * DESIGN CHANGE (DIP fix):
 *   The original file imported `getMessaging` from the Firebase Admin SDK
 *   directly — no seam for testing and an OCP violation if the push provider
 *   changes. Push dispatch now goes through IPushDispatcher, injected via
 *   NotificationServiceDeps. The concrete FirebasePushDispatcher is wired
 *   in NotificationsContainer and passed down via `notificationDeps`.
 *
 * PUSH POSTURE (unchanged):
 *   Push is non-critical. sendNotification() ALWAYS persists the DB row
 *   first. FCM failure is logged but never thrown to the caller — the user
 *   sees the notification in their inbox on next app open.
 * ==============================================================================
 */
import { logger } from '../../shared/logger/index.js';
import * as repo from './repository.js';
import type { UserRole } from '../../shared/rbac/roles.js';
import type { CreateNotificationInput, NotificationDto, NotificationListDto } from './types.js';
import type { NotificationServiceDeps } from './infrastructure/NotificationsContainer.js';

/* ==========================================================================
 * Token lifecycle
 * ========================================================================== */

export async function registerToken(params: {
  role: UserRole;
  entityId: number;
  deviceId: string;
  fcmToken: string;
  platform: 'ios' | 'android';
  deviceName?: string;
  appVersion?: string;
}): Promise<void> {
  await repo.upsertPushToken(params);
}

export async function unregisterToken(params: {
  role: UserRole;
  entityId: number;
  deviceId: string;
}): Promise<void> {
  await repo.deletePushToken(params);
}

/* ==========================================================================
 * Notification inbox
 * ========================================================================== */

export async function listNotifications(params: {
  role: UserRole;
  entityId: number;
  page: number;
  pageSize: number;
  category?: 'quote' | 'booking' | 'payment' | 'general';
  unreadOnly?: boolean;
}): Promise<NotificationListDto> {
  const { rows, total, unreadCount } = await repo.listNotifications(params);
  return {
    items: rows.map(rowToDto),
    total,
    unreadCount,
  };
}

export async function markNotificationRead(params: {
  uuid: string;
  role: UserRole;
  entityId: number;
}): Promise<void> {
  await repo.markNotificationRead(params);
}

export async function markAllRead(params: { role: UserRole; entityId: number }): Promise<void> {
  await repo.markAllNotificationsRead(params);
}

/* ==========================================================================
 * Send a notification (create row + dispatch push)
 *
 * Accepts NotificationServiceDeps so push dispatch is injectable.
 * The controller passes `notificationDeps` (production singleton).
 * Tests pass buildNotificationDeps({ push: new NoopPushDispatcher() }).
 *
 * Called by OTHER modules, not by this module's controller.
 * Example:
 *   import { sendNotification, notificationDeps } from '../notifications/index.js';
 *   await sendNotification(notificationDeps, {
 *     role: 'customer', entityId: customerId,
 *     kind: 'quotation_ready', category: 'quote',
 *     title: 'Quotation Ready!',
 *     body: `Your quotation ${q.quotationNo} is ready. Tap to view.`,
 *     payload: { kind: 'customer.quotationDetail', quotationId: q.uuid },
 *   });
 * ========================================================================== */

export async function sendNotification(
  deps: NotificationServiceDeps,
  input: CreateNotificationInput,
): Promise<void> {
  // 1. Persist the inbox row FIRST — even if push fails, the user sees it
  //    in the inbox when they open the app.
  let notifUuid: string;
  try {
    notifUuid = await repo.insertNotification(input);
  } catch (err) {
    logger.error(
      { err, role: input.role, entityId: input.entityId, kind: input.kind },
      'notifications: DB insert failed',
    );
    throw err;
  }

  // 2. Load FCM tokens — may be empty if the user denied push permission
  //    or never completed token registration.
  const tokenRows = await repo
    .getTokensForEntity({ role: input.role, entityId: input.entityId })
    .catch(err => {
      logger.error({ err }, 'notifications: failed to load push tokens');
      return [];
    });

  if (tokenRows.length === 0) {
    logger.info(
      { role: input.role, entityId: input.entityId, kind: input.kind },
      'notifications: no push tokens — inbox only',
    );
    return;
  }

  // 3. Dispatch push via injected IPushDispatcher (best-effort — never throws)
  const clickJson = input.payload ? JSON.stringify(input.payload) : undefined;
  const dispatchResult = await deps.push.dispatch({
    tokens: tokenRows.map(r => r.fcm_token),
    title: input.title,
    body: input.body,
    ...(clickJson !== undefined ? { click: clickJson } : {}),
  });

  // 4. Prune stale/invalid tokens returned by the dispatcher (fire-and-forget)
  if (dispatchResult.tokensToDelete.length > 0) {
    repo.deleteStalePushTokens(dispatchResult.tokensToDelete).catch(err => {
      logger.error({ err }, 'notifications: stale token pruning failed');
    });
  }

  logger.debug({ notifUuid }, 'notifications: send complete');
}

/* ==========================================================================
 * Helpers
 * ========================================================================== */

function rowToDto(row: import('./types.js').NotificationRow): NotificationDto {
  return {
    id: row.uuid,
    kind: row.kind,
    category: row.category,
    title: row.title,
    body: row.body,
    payload: row.payload,
    unread: row.read_at === null,
    timestamp: row.created_at.toISOString(),
  };
}

/**
 * ==============================================================================
 * notifications — service layer
 * ==============================================================================
 * Business logic only. No Express types. No SQL.
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
 * FCM SEND DESIGN:
 *   sendEachForMulticast (HTTP v1 API) — up to 500 tokens per call.
 *   Response array is index-aligned with tokens so stale ones can be pruned.
 *   Stale error codes per Firebase docs:
 *     https://firebase.google.com/docs/cloud-messaging/manage-tokens#detect-invalid-token-responses
 *
 *   Failure posture: push is non-critical. sendNotification() ALWAYS
 *   persists the DB row first. FCM failure is logged but never thrown
 *   to the caller — the user sees the notification in their inbox on
 *   next app open.
 * ==============================================================================
 */
import { getMessaging } from '../../shared/providers/firebase/admin.js';
import { logger } from '../../shared/logger/index.js';
import * as repo from './repository.js';
import type { UserRole } from '../../shared/rbac/roles.js';
import type {
  CreateNotificationInput,
  NotificationDto,
  NotificationListDto,
  PushDispatchResult,
} from './types.js';
import type { MulticastMessage, BatchResponse } from 'firebase-admin/messaging';

/* --------------------------------------------------------------------------
 * Stale-token error codes — FCM HTTP v1 API
 * Source: https://firebase.google.com/docs/cloud-messaging/manage-tokens
 * -------------------------------------------------------------------------- */
const STALE_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

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
 * Called by OTHER modules, not by this module's controller.
 * Example:
 *   import { sendNotification } from '../notifications/index.js';
 *   await sendNotification({
 *     role: 'customer', entityId: customerId,
 *     kind: 'quotation_ready', category: 'quote',
 *     title: 'Quotation Ready!',
 *     body: `Your quotation ${q.quotationNo} is ready. Tap to view.`,
 *     payload: { kind: 'customer.quotationDetail', quotationId: q.uuid },
 *   });
 * ========================================================================== */

export async function sendNotification(input: CreateNotificationInput): Promise<void> {
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
    .getTokensForEntity({
      role: input.role,
      entityId: input.entityId,
    })
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

  // 3. Dispatch FCM push (best-effort — never throws to caller)
  const clickJson = input.payload ? JSON.stringify(input.payload) : undefined;
  const dispatchResult = await dispatchFcmPush({
    tokens: tokenRows.map(r => r.fcm_token),
    title: input.title,
    body: input.body,
    ...(clickJson !== undefined ? { click: clickJson } : {}),
  });

  // 4. Prune stale/invalid tokens returned by FCM (fire-and-forget)
  if (dispatchResult.tokensToDelete.length > 0) {
    repo.deleteStalePushTokens(dispatchResult.tokensToDelete).catch(err => {
      logger.error({ err }, 'notifications: stale token pruning failed');
    });
  }

  // Log the uuid for correlation — useful in production when debugging
  // why a user didn't receive a push (notification row exists, push dispatch logged).
  logger.debug({ notifUuid }, 'notifications: send complete');
}

/* ==========================================================================
 * FCM dispatch — internal helper
 * ========================================================================== */

async function dispatchFcmPush(params: {
  tokens: string[];
  title: string;
  body: string;
  click?: string;
}): Promise<PushDispatchResult> {
  const tokensToDelete: string[] = [];
  let successCount = 0;

  try {
    const messaging = getMessaging();
    const CHUNK_SIZE = 500;

    for (let i = 0; i < params.tokens.length; i += CHUNK_SIZE) {
      const chunk = params.tokens.slice(i, i + CHUNK_SIZE);

      /**
       * MulticastMessage uses `tokens` (plural) for sendEachForMulticast.
       * `data` values must all be strings — FCM's wire format requirement.
       * `click` carries the JSON-serialized DeepLinkTarget so the client's
       * resolveFcmClick() can parse it via Zod on tap.
       *
       * android.priority 'high' wakes the background handler for data-only
       * messages. For notification+data messages (like ours) the OS already
       * shows the notification, but high priority is correct for transactional
       * content regardless.
       *
       * apns.payload.aps.contentAvailable true is the iOS equivalent for
       * data-only background wakeup; harmless for notification+data.
       */
      const message: MulticastMessage = {
        tokens: chunk,
        notification: {
          title: params.title,
          body: params.body,
        },
        data: params.click !== undefined ? { click: params.click } : {},
        android: {
          priority: 'high',
          notification: { channelId: 'default' },
        },
        apns: {
          payload: { aps: { contentAvailable: true } },
        },
      };

      const response: BatchResponse = await messaging.sendEachForMulticast(message);
      successCount += response.successCount;

      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          const code = resp.error?.code ?? '';
          logger.warn(
            { code, token: maskToken(chunk[idx] ?? '') },
            'notifications: FCM send failed for token',
          );
          if (STALE_TOKEN_CODES.has(code)) {
            const token = chunk[idx];
            if (token !== undefined) tokensToDelete.push(token);
          }
        }
      });
    }

    logger.info(
      { successCount, stalePruned: tokensToDelete.length },
      'notifications: FCM dispatch complete',
    );
  } catch (err) {
    logger.error({ err }, 'notifications: FCM sendEachForMulticast threw');
  }

  return { successCount, tokensToDelete };
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

function maskToken(token: string): string {
  if (token.length < 16) return '****';
  return `${token.slice(0, 8)}…${token.slice(-4)}`;
}

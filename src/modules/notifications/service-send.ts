/**
 * ==============================================================================
 * notifications.service — send orchestration
 * ==============================================================================
 * Owns the write path that other modules call when they want to notify a user:
 *   sendNotification(deps, input) — persist inbox row + dispatch push
 *
 * ORDER OF OPERATIONS (invariant — do not reorder):
 *   1. INSERT the notifications row first. Even if push fails entirely, the
 *      user sees the notification in their inbox on next app open.
 *   2. Load FCM tokens for the entity. If none exist, return early (inbox only).
 *   3. Dispatch via deps.push.dispatch() — non-throwing by contract.
 *   4. Fire-and-forget prune of stale tokens returned by the dispatcher.
 *
 * SRP: this file knows only about send orchestration. It has no knowledge of
 * inbox read-side state or token registration lifecycle. It calls the
 * repository directly (step 1 & 2) and delegates push to IPushDispatcher
 * (step 3) — that is its entire job.
 *
 * PUSH POSTURE:
 *   Push is non-critical. A failed push never throws to the caller. The
 *   inbox row is the durable record; push is a convenience delivery channel.
 * ==============================================================================
 */
import { logger } from '../../shared/logger/index.js';
import * as repo from './repository.js';
import type { CreateNotificationInput } from './types.js';
import type { NotificationServiceDeps } from './infrastructure/NotificationsContainer.js';

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

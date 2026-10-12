/**
 * Delivers a notification. The inbox row is written first and is the durable
 * record; push is best-effort and never throws to the caller.
 */
import { logger } from '../../shared/logger/index.js';
import * as repo from './repository.js';
import type { CreateNotificationInput } from './types.js';
import type { NotificationServiceDeps } from './infrastructure/NotificationsContainer.js';

export async function sendNotification(
  deps: NotificationServiceDeps,
  input: CreateNotificationInput,
): Promise<void> {
  // Inbox row first, so the user sees it even if push fails.
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

  // Empty when push permission was denied or no token was registered.
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

  // dispatch() never throws.
  const clickJson = input.payload ? JSON.stringify(input.payload) : undefined;
  const dispatchResult = await deps.push.dispatch({
    tokens: tokenRows.map(r => r.fcm_token),
    title: input.title,
    body: input.body,
    ...(clickJson !== undefined ? { click: clickJson } : {}),
  });

  // Prune invalid tokens in the background.
  if (dispatchResult.tokensToDelete.length > 0) {
    repo.deleteStalePushTokens(dispatchResult.tokensToDelete).catch(err => {
      logger.error({ err }, 'notifications: stale token pruning failed');
    });
  }

  logger.debug({ notifUuid }, 'notifications: send complete');
}

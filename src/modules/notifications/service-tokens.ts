/**
 * ==============================================================================
 * notifications.service — token lifecycle
 * ==============================================================================
 * Owns the `push_tokens` table surface:
 *   registerToken   — upsert an FCM token for a (role, entity, device) triple.
 *                     Called on login and on cold app start when the OS issues
 *                     a fresh token.
 *   unregisterToken — hard-delete the token for a specific device. Called on
 *                     logout so that device no longer receives pushes for this
 *                     user.
 *
 * SRP: this file knows only about token persistence. It has no knowledge of
 * the notifications inbox, push dispatch, or any business event.
 * ==============================================================================
 */
import * as repo from './repository.js';
import type { UserRole } from '../../shared/rbac/roles.js';

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

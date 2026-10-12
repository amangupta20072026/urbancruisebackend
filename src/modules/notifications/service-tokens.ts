/** Push token lifecycle: register on login/cold start, delete on logout. */
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

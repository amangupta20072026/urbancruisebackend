/**
 * Wires the notifications dependencies. Production uses notificationDeps;
 * tests call buildNotificationDeps({ push: fake }) so no Firebase SDK loads.
 */
import { FirebasePushDispatcher } from './FirebasePushDispatcher.js';
import type { IPushDispatcher } from '../ports/IPushDispatcher.js';

export type NotificationServiceDeps = {
  readonly push: IPushDispatcher;
};

export function buildNotificationDeps(overrides: {
  push?: IPushDispatcher;
}): NotificationServiceDeps {
  const push = overrides.push ?? new FirebasePushDispatcher();
  return Object.freeze({ push });
}

export const notificationDeps: NotificationServiceDeps = buildNotificationDeps({});

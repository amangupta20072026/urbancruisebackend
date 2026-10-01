/**
 * ==============================================================================
 * NotificationsContainer — dependency wiring for the notifications module
 * ==============================================================================
 * Wires the production IPushDispatcher implementation and exposes:
 *
 *   NotificationServiceDeps  — the deps bundle every service function receives
 *   buildNotificationDeps()  — factory used by production code + tests
 *   notificationDeps         — production singleton imported by the service
 *
 * TEST OVERRIDE:
 *   Tests call buildNotificationDeps({ push: new NoopPushDispatcher() })
 *   and pass the result to service functions. No Firebase SDK is loaded.
 *
 * PRODUCTION:
 *   The service imports `notificationDeps` and passes it through.
 * ==============================================================================
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

/**
 * ==============================================================================
 * notifications — service barrel
 * ==============================================================================
 * Re-exports every service entry point from the three focused files below.
 * The controller and index.ts import from here so no call site changes.
 *
 * RESPONSIBILITY SPLIT (SRP fix):
 *   service-tokens.ts  — FCM token lifecycle (registerToken, unregisterToken)
 *   service-inbox.ts   — Notification inbox (list, markRead, markAllRead)
 *   service-send.ts    — Send orchestration (DB insert + push dispatch)
 *
 * Each file owns one reason to change:
 *   token lifecycle changes  → only service-tokens.ts
 *   inbox query changes      → only service-inbox.ts
 *   send flow changes        → only service-send.ts
 * ==============================================================================
 */
export { registerToken, unregisterToken } from './service-tokens.js';
export { listNotifications, markNotificationRead, markAllRead } from './service-inbox.js';
export { sendNotification } from './service-send.js';

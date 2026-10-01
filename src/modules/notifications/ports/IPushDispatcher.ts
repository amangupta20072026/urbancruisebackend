/**
 * ==============================================================================
 * IPushDispatcher — port for FCM push delivery
 * ==============================================================================
 * Abstracts the Firebase Admin SDK so the notification service depends on
 * this interface, not on the concrete `getMessaging()` import.
 *
 * WHY THIS EXISTS (DIP violation in the original code):
 *   service.ts imported `getMessaging` from the Firebase Admin SDK directly.
 *   This meant:
 *     1. Tests could not run without a real Firebase project — no seam to inject
 *        a fake dispatcher.
 *     2. Swapping FCM for another push provider (APNs direct, OneSignal, etc.)
 *        required touching service business logic. That's an OCP violation.
 *
 * CONTRACT:
 *   dispatch() MUST NOT throw to the caller. FCM push is best-effort —
 *   a failed push never prevents the inbox row from being persisted.
 *   Implementations catch internally, log the error, and resolve with a
 *   result that has successCount = 0 and empty tokensToDelete.
 *
 * IMPLEMENTATIONS
 *   FirebasePushDispatcher — wraps Firebase Admin SDK (production)
 *   NoopPushDispatcher     — discards every dispatch silently (unit tests
 *                            that don't assert push behaviour)
 *   SpyPushDispatcher      — records every call (unit tests that do assert)
 * ==============================================================================
 */
import type { PushDispatchResult } from '../types.js';

export type PushDispatchParams = {
  /** FCM registration tokens — up to 500 per call (chunked internally). */
  tokens: string[];
  title: string;
  body: string;
  /**
   * JSON-serialised DeepLinkTarget. Passed as `data.click` on the FCM
   * message so the client's resolveFcmClick() can parse it on tap.
   * Omit when there is no tap action.
   */
  click?: string;
};

export interface IPushDispatcher {
  /**
   * Deliver a push notification to one or more FCM tokens.
   *
   * CONTRACT: MUST NOT throw. Returns a result object even on total failure.
   * Callers rely on this to keep push non-blocking for the DB write that
   * always happens first.
   */
  dispatch(params: PushDispatchParams): Promise<PushDispatchResult>;
}

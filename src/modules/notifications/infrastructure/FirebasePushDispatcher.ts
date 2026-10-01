/**
 * ==============================================================================
 * FirebasePushDispatcher — production IPushDispatcher backed by Firebase Admin
 * ==============================================================================
 * Wraps the `getMessaging()` singleton from shared/providers/firebase/admin.ts.
 * All FCM-specific details (MulticastMessage shape, chunk size, stale-token
 * error codes, apns/android platform options) live here — the service layer
 * knows nothing about FCM.
 *
 * CHUNKING: FCM's sendEachForMulticast accepts up to 500 tokens per call.
 * We chunk at 500 and aggregate results across chunks.
 *
 * STALE TOKEN DETECTION: per Firebase docs:
 *   https://firebase.google.com/docs/cloud-messaging/manage-tokens#detect-invalid-token-responses
 *
 * NON-THROWING: any error from the FCM SDK is caught, logged, and returned
 * as a zero-success result so the caller's inbox write is never blocked.
 * ==============================================================================
 */
import type { IPushDispatcher, PushDispatchParams } from '../ports/IPushDispatcher.js';
import type { PushDispatchResult } from '../types.js';
import type { MulticastMessage, BatchResponse } from 'firebase-admin/messaging';
import { getMessaging } from '../../../shared/providers/firebase/admin.js';
import { logger } from '../../../shared/logger/index.js';

/** FCM error codes that indicate a token is permanently invalid. */
const STALE_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

const CHUNK_SIZE = 500;

export class FirebasePushDispatcher implements IPushDispatcher {
  async dispatch(params: PushDispatchParams): Promise<PushDispatchResult> {
    const tokensToDelete: string[] = [];
    let successCount = 0;

    try {
      const messaging = getMessaging();

      for (let i = 0; i < params.tokens.length; i += CHUNK_SIZE) {
        const chunk = params.tokens.slice(i, i + CHUNK_SIZE);

        /**
         * MulticastMessage shape for sendEachForMulticast (HTTP v1 API).
         *
         * `data` values must all be strings — FCM wire format requirement.
         * `click` carries the JSON-serialized DeepLinkTarget so the client's
         * resolveFcmClick() can parse it on tap.
         *
         * android.priority 'high' wakes the background handler for data-only
         * messages. For notification+data messages the OS already shows the
         * notification, but high priority is correct for transactional content.
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
}

function maskToken(token: string): string {
  if (token.length < 16) return '****';
  return `${token.slice(0, 8)}…${token.slice(-4)}`;
}

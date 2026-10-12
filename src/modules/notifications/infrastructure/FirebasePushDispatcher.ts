/**
 * IPushDispatcher backed by Firebase Admin (FCM HTTP v1 via sendEachForMulticast).
 *
 * Targets:
 *   - FIDs   → FidMulticastMessage (the current, non-deprecated API).
 *   - Tokens → legacy MulticastMessage. Deprecated in firebase-admin 14.1.0 but
 *              still fully supported by FCM during the FID transition.
 *
 * Why tokens are still sent: the app uses @react-native-firebase/messaging,
 * which (as of 26.4.0) does not expose FCM's register() / onRegistered() FID
 * APIs. Without them the app cannot obtain a *registered* FID, and sending to
 * an unregistered one fails with NotRegistered. Remove the token path once the
 * app registers FIDs and every stored row has been migrated.
 *
 * Behaviour:
 *   - Chunks of 500 (the documented sendEachForMulticast limit).
 *   - Each chunk is isolated: one failed chunk never drops the others.
 *   - Permanently invalid targets are returned for pruning.
 *   - Never throws.
 */
import { getMessaging } from '../../../shared/providers/firebase/admin.js';
import { logger } from '../../../shared/logger/index.js';
import {
  MessagingErrorCode,
  type BaseMessage,
  type BatchResponse,
  type FidMulticastMessage,
} from 'firebase-admin/messaging';
import type { IPushDispatcher, PushDispatchParams } from '../ports/IPushDispatcher.js';
import type { PushDispatchResult } from '../types.js';

/** Documented maximum targets per sendEachForMulticast call. */
const CHUNK_SIZE = 500;

/**
 * Error codes meaning the target can never receive a message again, so it is
 * safe to delete. Matched with FirebaseError.hasCode(), which accepts the
 * un-prefixed code.
 */
const PERMANENTLY_INVALID_CODES: readonly string[] = [
  MessagingErrorCode.REGISTRATION_TOKEN_NOT_REGISTERED,
  MessagingErrorCode.INVALID_REGISTRATION_TOKEN,
  MessagingErrorCode.INSTALLATION_ID_NOT_REGISTERED,
];

type TargetKind = 'fid' | 'token';

type ChunkOutcome = { successCount: number; invalid: string[] };

export class FirebasePushDispatcher implements IPushDispatcher {
  async dispatch(params: PushDispatchParams): Promise<PushDispatchResult> {
    const base = buildBaseMessage(params);
    let successCount = 0;
    const tokensToDelete: string[] = [];

    const targets: ReadonlyArray<readonly [TargetKind, readonly string[]]> = [
      ['fid', params.fids ?? []],
      ['token', params.tokens],
    ];

    for (const [kind, ids] of targets) {
      for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
        const chunk = ids.slice(i, i + CHUNK_SIZE);
        const outcome = await sendChunk(kind, chunk, base);
        successCount += outcome.successCount;
        tokensToDelete.push(...outcome.invalid);
      }
    }

    logger.info(
      {
        fidCount: params.fids?.length ?? 0,
        tokenCount: params.tokens.length,
        successCount,
        stalePruned: tokensToDelete.length,
      },
      'notifications: FCM dispatch complete',
    );

    return { successCount, tokensToDelete };
  }
}

/**
 * Payload shared by every target. FCM data values must be strings; `click`
 * is the deep-link JSON. High priority (Android) and contentAvailable (iOS)
 * suit transactional messages and wake the app's background handler.
 */
function buildBaseMessage(params: PushDispatchParams): BaseMessage {
  return {
    notification: { title: params.title, body: params.body },
    data: params.click !== undefined ? { click: params.click } : {},
    android: {
      priority: 'high',
      notification: { channelId: 'default' },
    },
    apns: {
      payload: { aps: { contentAvailable: true } },
    },
  };
}

/** Sends one chunk. Never throws. */
async function sendChunk(
  kind: TargetKind,
  chunk: readonly string[],
  base: BaseMessage,
): Promise<ChunkOutcome> {
  try {
    const response =
      kind === 'fid' ? await sendToFids(chunk, base) : await sendToLegacyTokens(chunk, base);
    return collectOutcome(kind, chunk, response);
  } catch (err) {
    // A thrown error means the whole chunk failed (e.g. auth or network).
    logger.error({ err, kind, chunkSize: chunk.length }, 'notifications: FCM chunk send threw');
    return { successCount: 0, invalid: [] };
  }
}

function sendToFids(fids: readonly string[], base: BaseMessage): Promise<BatchResponse> {
  const message: FidMulticastMessage = { ...base, fids: [...fids] };
  return getMessaging().sendEachForMulticast(message);
}

/**
 * The only use of the deprecated token API in the codebase, so the editor
 * shows exactly one deprecation hint (ts 6385), on the call below. That hint
 * is intentional: FCM still fully supports tokens, and the app cannot
 * register FIDs yet. The object literal is still type-checked against the
 * token overload of sendEachForMulticast.
 * TODO(fcm-fid-migration): delete once the app registers FIDs.
 */
function sendToLegacyTokens(tokens: readonly string[], base: BaseMessage): Promise<BatchResponse> {
  return getMessaging().sendEachForMulticast({ ...base, tokens: [...tokens] });
}

/** responses[i] corresponds to chunk[i] (documented ordering guarantee). */
function collectOutcome(
  kind: TargetKind,
  chunk: readonly string[],
  response: BatchResponse,
): ChunkOutcome {
  const invalid: string[] = [];

  response.responses.forEach((resp, idx) => {
    if (resp.success) return;
    const target = chunk[idx];
    const err = resp.error;
    const isPermanent = err !== undefined && PERMANENTLY_INVALID_CODES.some(c => err.hasCode(c));

    logger.warn(
      { kind, code: err?.code, target: mask(target ?? ''), willPrune: isPermanent },
      'notifications: FCM send failed for target',
    );

    if (isPermanent && target !== undefined) invalid.push(target);
  });

  return { successCount: response.successCount, invalid };
}

function mask(id: string): string {
  if (id.length < 16) return '****';
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

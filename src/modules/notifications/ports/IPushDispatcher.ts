/**
 * Port for push delivery. The notifications service depends on this, never on
 * the Firebase SDK directly.
 *
 * FCM is moving from registration tokens to Firebase Installation IDs (FIDs).
 * Both are accepted here so the service can send to either during the
 * migration. Today the mobile app registers tokens only (see
 * FirebasePushDispatcher for why), so `fids` is normally empty.
 */
import type { PushDispatchResult } from '../types.js';

export type PushDispatchParams = {
  /** Legacy FCM registration tokens; chunked by the implementation. */
  tokens: readonly string[];
  /** Registered Firebase Installation IDs; chunked by the implementation. */
  fids?: readonly string[];
  title: string;
  body: string;
  /** DeepLinkTarget JSON, sent as data.click. Omit for no tap action. */
  click?: string;
};

export interface IPushDispatcher {
  /** Sends a push to the given targets. Must never throw; returns a result even on total failure. */
  dispatch(params: PushDispatchParams): Promise<PushDispatchResult>;
}

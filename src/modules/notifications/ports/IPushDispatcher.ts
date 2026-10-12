/**
 * Port for push delivery, so the service doesn't depend on Firebase and
 * tests can inject a fake. Implementation: FirebasePushDispatcher.
 */
import type { PushDispatchResult } from '../types.js';

export type PushDispatchParams = {
  /** FCM registration tokens; chunked by the implementation. */
  tokens: string[];
  title: string;
  body: string;
  /** DeepLinkTarget JSON, sent as data.click. Omit for no tap action. */
  click?: string;
};

export interface IPushDispatcher {
  /** Sends a push to the given tokens. Must never throw; returns a result even on total failure. */
  dispatch(params: PushDispatchParams): Promise<PushDispatchResult>;
}

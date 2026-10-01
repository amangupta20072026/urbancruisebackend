/**
 * ==============================================================================
 * PushDispatcherFakes — test doubles for IPushDispatcher
 * ==============================================================================
 *
 * NoopPushDispatcher
 *   Silently discards every dispatch. Use in tests that don't care about
 *   push behaviour — the focus is on DB writes, inbox state, etc.
 *
 * SpyPushDispatcher
 *   Records every dispatch() call in `calls[]`. Use in tests that assert
 *   push payloads (title, body, token count, click payload, etc.).
 *   Also supports injecting a controlled result (e.g. with stale tokens)
 *   to exercise the pruning path without a live FCM connection.
 *
 * USAGE — test that doesn't care about push:
 *   const deps = buildNotificationDeps({ push: new NoopPushDispatcher() });
 *   await sendNotification(deps, { ... });
 *
 * USAGE — test that asserts push was called:
 *   const push = new SpyPushDispatcher();
 *   const deps = buildNotificationDeps({ push });
 *   await sendNotification(deps, { ... });
 *   expect(push.calls).toHaveLength(1);
 *   expect(push.calls[0]?.title).toBe('Quotation Ready!');
 *
 * USAGE — test stale-token pruning:
 *   const push = new SpyPushDispatcher({
 *     result: { successCount: 0, tokensToDelete: ['stale-token-xyz'] }
 *   });
 * ==============================================================================
 */
import type { IPushDispatcher, PushDispatchParams } from '../../ports/IPushDispatcher.js';
import type { PushDispatchResult } from '../../types.js';

/* --------------------------------------------------------------------------
 * NoopPushDispatcher
 * -------------------------------------------------------------------------- */
export class NoopPushDispatcher implements IPushDispatcher {
  async dispatch(_params: PushDispatchParams): Promise<PushDispatchResult> {
    return { successCount: 0, tokensToDelete: [] };
  }
}

/* --------------------------------------------------------------------------
 * SpyPushDispatcher
 * -------------------------------------------------------------------------- */
export class SpyPushDispatcher implements IPushDispatcher {
  readonly calls: PushDispatchParams[] = [];

  private readonly _result: PushDispatchResult;

  constructor(options?: { result?: PushDispatchResult }) {
    this._result = options?.result ?? { successCount: 1, tokensToDelete: [] };
  }

  async dispatch(params: PushDispatchParams): Promise<PushDispatchResult> {
    this.calls.push(params);
    return this._result;
  }

  reset(): void {
    this.calls.length = 0;
  }

  /** Returns the first recorded call, or undefined if dispatch was never called. */
  get lastCall(): PushDispatchParams | undefined {
    return this.calls[this.calls.length - 1];
  }
}

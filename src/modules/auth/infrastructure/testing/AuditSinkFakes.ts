/**
 * ==============================================================================
 * AuditSinkFakes — test doubles for IAuditSink
 * ==============================================================================
 *
 * NoopAuditSink  — silently discards every event.
 *                  Use when a test doesn't care about audit at all.
 *
 * SpyAuditSink   — collects every record() call in `events`.
 *                  Use when a test needs to assert specific audit events.
 *
 * USAGE:
 *
 *   // Test that doesn't care about audit
 *   const deps = buildAuthDeps({ audit: new NoopAuditSink() });
 *
 *   // Test that asserts audit events
 *   const auditSink = new SpyAuditSink();
 *   const deps = buildAuthDeps({ audit: auditSink });
 *   await sendOtp(deps, { ... });
 *   expect(auditSink.events).toHaveLength(1);
 *   expect(auditSink.events[0]?.event).toBe('send_succeeded');
 * ==============================================================================
 */

import type { IAuditSink, AuditEventInput } from '../../ports/IAuditSink.js';

export class NoopAuditSink implements IAuditSink {
  async record(_event: AuditEventInput): Promise<void> {
    // intentional no-op
  }
}

export class SpyAuditSink implements IAuditSink {
  readonly events: AuditEventInput[] = [];

  async record(event: AuditEventInput): Promise<void> {
    this.events.push(event);
  }

  reset(): void {
    this.events.length = 0;
  }

  /** Find the first event matching the given predicate. */
  find(predicate: (e: AuditEventInput) => boolean): AuditEventInput | undefined {
    return this.events.find(predicate);
  }

  /** Return all events for a given event type. */
  ofType(event: AuditEventInput['event']): AuditEventInput[] {
    return this.events.filter(e => e.event === event);
  }
}

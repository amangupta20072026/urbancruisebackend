/**
 * ==============================================================================
 * auth.service — audit helper
 * ==============================================================================
 * Thin dispatch function that routes an AuditEventInput to the injected sink.
 *
 * AuditEventInput is defined in ports/IAuditSink.ts (not here) to avoid a
 * circular import (IAuditSink ← service/audit → IAuditSink). Re-exported from
 * here so existing import paths in service files don't change.
 *
 * NON-THROWING: the IAuditSink contract guarantees no throws. This function
 * adds no extra try/catch — the sink handles errors internally.
 * ==============================================================================
 */
import type { IAuditSink, AuditEventInput } from '../ports/IAuditSink.js';

// Re-export so service files can do: import type { AuditEventInput } from './audit.js'
export type { AuditEventInput };

export async function audit(sink: IAuditSink, a: AuditEventInput): Promise<void> {
  await sink.record(a);
}

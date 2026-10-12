/** Sends an audit event to the injected sink. The sink never throws. */
import type { IAuditSink, AuditEventInput } from '../ports/IAuditSink.js';

export type { AuditEventInput };

export async function audit(sink: IAuditSink, a: AuditEventInput): Promise<void> {
  await sink.record(a);
}

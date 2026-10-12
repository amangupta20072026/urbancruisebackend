/**
 * Port for OTP audit events, so the storage (SQL today, possibly a queue
 * later) can change without touching services, and tests can capture events.
 * AuditEventInput lives here to avoid a circular import with service/audit.ts.
 * Implementation: SqlAuditSink.
 */

import type { UserRole } from '../../../shared/rbac/roles.js';

export type AuditEventInput = {
  mobile: string;
  role: UserRole;
  event:
    | 'send_requested'
    | 'send_succeeded'
    | 'send_failed'
    | 'verify_succeeded'
    | 'verify_failed'
    | 'rate_limited'
    | 'account_not_provisioned';
  /** Defaults to 'login'. */
  purpose?: 'login' | 'change_mobile' | 'reverify';
  /** Defaults to 'sms'; 'test' for test mobiles. */
  channel?: 'sms' | 'test';
  /** Defaults to 'msg91'. */
  provider?: string;
  providerRequestId?: string | null;
  code?: string;
  msg?: string;
  attemptNumber?: number;
  idempotencyKey?: string | null;
  isTest?: boolean;
  ip?: string | null;
};

export interface IAuditSink {
  /** Stores one event. Must never throw: a lost audit row beats failing the user's login. */
  record(event: AuditEventInput): Promise<void>;
}

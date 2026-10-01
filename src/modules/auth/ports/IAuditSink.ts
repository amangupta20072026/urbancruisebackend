/**
 * ==============================================================================
 * IAuditSink — port for OTP audit event persistence
 * ==============================================================================
 * The audit helper in service/audit.ts previously called repo.insertOtpEvent
 * directly (hardwired to MySQL + the 'msg91' provider string). The problem:
 *
 *   1. Swapping from synchronous INSERT to a BullMQ-backed queue (as the
 *      comment in audit.ts already acknowledged) requires touching service
 *      business logic. That's an OCP violation.
 *   2. There's no seam for unit tests to verify that audit events are emitted
 *      without spinning up a real DB.
 *
 * AuditEventInput is defined here (not in service/audit.ts) to avoid a
 * circular dependency: IAuditSink ← service/audit → IAuditSink.
 *
 * IMPLEMENTATIONS
 *   SqlAuditSink   — calls repo.insertOtpEvent synchronously (production MVP)
 *   QueueAuditSink — enqueues via BullMQ (future, zero code change in service)
 *   NoopAuditSink  — discards every event (unit tests that don't assert audit)
 *   SpyAuditSink   — collects events in an array (unit tests that DO assert)
 * ==============================================================================
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
  /** Defaults to 'login'. Widen when change_mobile / reverify flows land. */
  purpose?: 'login' | 'change_mobile' | 'reverify';
  /** Defaults to 'sms'. Pass 'test' for test-mobile paths. */
  channel?: 'sms' | 'test';
  /** Defaults to 'msg91'. Pass the actual provider name when email / WhatsApp land. */
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
  /**
   * Persist one audit event.
   *
   * CONTRACT: implementations MUST NOT throw. The auth flow continues even
   * if audit persistence fails — a dropped row is preferable to a 500 for a
   * real user. Implementations should catch internally, log the error, and
   * resolve.
   */
  record(event: AuditEventInput): Promise<void>;
}

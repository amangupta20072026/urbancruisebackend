/**
 * ==============================================================================
 * auth.service — audit helper
 * ==============================================================================
 * Best-effort wrapper around `repo.insertOtpEvent`.
 *
 * Audit failures MUST NEVER block auth. If the audit write throws we log the
 * error and swallow it — the user still needs their OTP, and losing one
 * audit row is better than 5xx-ing a real user.
 *
 * Every send/verify path in this module funnels through `audit()`, so this
 * is the one place to change if we ever want to sink audit events into a
 * queue (BullMQ) instead of a synchronous INSERT.
 * ==============================================================================
 */
import { logger } from '../../../shared/logger/index.js';
import * as repo from '../repository/index.js';
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
  channel?: 'sms' | 'test';
  providerRequestId?: string | null;
  code?: string;
  msg?: string;
  attemptNumber?: number;
  idempotencyKey?: string | null;
  isTest?: boolean;
  ip?: string | null;
};

/**
 * Insert one otp_events row. Non-throwing.
 */
export async function audit(a: AuditEventInput): Promise<void> {
  try {
    await repo.insertOtpEvent({
      mobile: a.mobile,
      roleRequested: a.role,
      purpose: 'login',
      eventType: a.event,
      channel: a.channel ?? 'sms',
      provider: 'msg91',
      msg91RequestId: a.providerRequestId ?? null,
      msg91ErrorCode: a.code ?? null,
      msg91ErrorMessage: a.msg ?? null,
      attemptNumber: a.attemptNumber ?? 1,
      idempotencyKey: a.idempotencyKey ?? null,
      ip: a.ip ?? null,
      isTest: a.isTest ?? false,
    });
  } catch (err) {
    logger.error({ err }, 'otp_events insert failed (non-blocking)');
  }
}

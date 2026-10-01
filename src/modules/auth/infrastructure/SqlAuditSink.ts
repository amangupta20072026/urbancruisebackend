/**
 * ==============================================================================
 * SqlAuditSink — production IAuditSink (synchronous MySQL INSERT)
 * ==============================================================================
 * Non-throwing: every internal error is caught, logged, and swallowed.
 * The caller (audit helper) must not need a try/catch around record().
 *
 * FUTURE SWAP: to move audit events to a BullMQ queue, implement
 * QueueAuditSink and swap in AuthContainer — no service code changes.
 * ==============================================================================
 */

import type { IAuditSink, AuditEventInput } from '../ports/IAuditSink.js';
import type { IAuthRepository } from '../ports/IAuthRepository.js';
import { logger } from '../../../shared/logger/index.js';

export class SqlAuditSink implements IAuditSink {
  constructor(private readonly repo: IAuthRepository) {}

  async record(a: AuditEventInput): Promise<void> {
    try {
      await this.repo.insertOtpEvent({
        mobile: a.mobile,
        roleRequested: a.role,
        purpose: a.purpose ?? 'login',
        eventType: a.event,
        channel: a.channel ?? 'sms',
        provider: a.provider ?? 'msg91',
        msg91RequestId: a.providerRequestId ?? null,
        msg91ErrorCode: a.code ?? null,
        msg91ErrorMessage: a.msg ?? null,
        attemptNumber: a.attemptNumber ?? 1,
        idempotencyKey: a.idempotencyKey ?? null,
        ip: a.ip ?? null,
        isTest: a.isTest ?? false,
      });
    } catch (err) {
      logger.error({ err }, 'SqlAuditSink: otp_events insert failed (non-blocking)');
    }
  }
}

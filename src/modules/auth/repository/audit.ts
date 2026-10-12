/** auth repository: otp_events and login_events inserts, and MSG91 DLR updates. */
import type { ResultSetHeader } from 'mysql2/promise';
import { pool } from '../../../shared/db/pool.js';
import type { DeviceMeta } from '../types.js';
import type { UserRole } from '../../../shared/rbac/roles.js';

/* otp_events */

export type OtpEventInsert = {
  mobile: string;
  roleRequested: UserRole;
  purpose: 'login' | 'change_mobile' | 'reverify';
  eventType:
    | 'send_requested'
    | 'send_succeeded'
    | 'send_failed'
    | 'verify_succeeded'
    | 'verify_failed'
    | 'rate_limited'
    | 'account_not_provisioned';
  /** 'sms' for MSG91, 'test' for test mobiles. Old rows may hold 'whatsapp' or 'voice'. */
  channel: 'sms' | 'test';
  provider?: string;
  msg91RequestId?: string | null;
  msg91ErrorCode?: string | null;
  msg91ErrorMessage?: string | null;
  idempotencyKey?: string | null;
  attemptNumber?: number;
  ip?: string | null;
  deviceId?: string | null;
  isTest?: boolean;
  accessTokenHash?: string | null;
  deliveryStatus?:
    'pending' | 'sent' | 'delivered' | 'read' | 'failed' | 'user_blocked' | 'undeliverable';
};

export async function insertOtpEvent(e: OtpEventInsert): Promise<void> {
  // fallback_from_channel is legacy; always written as NULL.
  await pool.execute(
    `INSERT INTO otp_events
       (mobile, role_requested, purpose, event_type, channel, provider,
        idempotency_key, attempt_number, fallback_from_channel,
        msg91_request_id, msg91_error_code, msg91_error_message,
        access_token_hash, ip, device_id, is_test, delivery_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, INET6_ATON(?), ?, ?, ?)`,
    [
      e.mobile,
      e.roleRequested,
      e.purpose,
      e.eventType,
      e.channel,
      e.provider ?? 'msg91',
      e.idempotencyKey ?? null,
      e.attemptNumber ?? 1,
      null, // fallback_from_channel
      e.msg91RequestId ?? null,
      e.msg91ErrorCode ?? null,
      e.msg91ErrorMessage ?? null,
      e.accessTokenHash ?? null,
      e.ip ?? null,
      e.deviceId ?? null,
      e.isTest ? 1 : 0,
      e.deliveryStatus ?? 'pending',
    ],
  );
}

/* login_events */

export type LoginEventInsert = {
  role: UserRole;
  entityId: string | null;
  mobile: string;
  outcome:
    | 'success'
    | 'account_suspended'
    | 'account_not_provisioned'
    | 'account_not_found'
    | 'otp_invalid'
    | 'system_error';
  sessionId?: number | null;
  ip?: string | null;
  device?: DeviceMeta | null;
  userAgent?: string | null;
};

export async function insertLoginEvent(e: LoginEventInsert): Promise<void> {
  await pool.execute(
    `INSERT INTO login_events
       (role, entity_id, mobile, outcome, session_id,
        ip, device_id, device_name, platform, app_version, user_agent)
     VALUES (?, ?, ?, ?, ?, INET6_ATON(?), ?, ?, ?, ?, ?)`,
    [
      e.role,
      e.entityId,
      e.mobile,
      e.outcome,
      e.sessionId ?? null,
      e.ip ?? null,
      e.device?.id ?? null,
      e.device?.name ?? null,
      e.device?.platform ?? null,
      e.device?.appVersion ?? null,
      e.userAgent ?? null,
    ],
  );
}

/*
 * MSG91 delivery reports. A row moves once from 'pending' to a final status
 * and is never changed after, so duplicate or late reports are no-ops.
 * Matched on msg91_request_id, set when MSG91 accepted the SMS.
 */

/** Maps an MSG91 DLR to the otp_events.delivery_status enum. */
function dlrToDeliveryStatus(
  dlr: 'delivered' | 'failed' | 'rejected',
  description: string | null,
): 'delivered' | 'failed' | 'undeliverable' | 'user_blocked' {
  if (dlr === 'delivered') return 'delivered';
  if (dlr === 'rejected') {
    // DND means the recipient blocked us; other rejections are permanent policy failures.
    if (description && /dnd|blocked/i.test(description)) return 'user_blocked';
    return 'undeliverable';
  }
  // Carrier failure: MSG91's description tells permanent from transient.
  if (
    description &&
    /permanent|ported|teleservice|barred|memexcd|memory|not\s*provisioned|invalid/i.test(
      description,
    )
  ) {
    return 'undeliverable';
  }
  return 'failed';
}

export type DlrUpdate = {
  msg91RequestId: string;
  dlr: 'delivered' | 'failed' | 'rejected';
  description: string | null;
  providerStatusCode: number | null;
};

/**
 * Applies a DLR to its pending otp_events row. Returns rows updated: 0 if
 * the request id is unknown or the row is already final. Safe to retry.
 */
export async function applyDlr(update: DlrUpdate): Promise<number> {
  const newStatus = dlrToDeliveryStatus(update.dlr, update.description);
  const isFailure = newStatus !== 'delivered';
  const [result] = await pool.execute<ResultSetHeader>(
    `UPDATE otp_events
        SET delivery_status    = ?,
            msg91_error_code   = COALESCE(msg91_error_code,   ?),
            msg91_error_message = COALESCE(msg91_error_message, ?)
      WHERE msg91_request_id = ?
        AND delivery_status  = 'pending'`,
    [
      newStatus,
      isFailure && update.providerStatusCode !== null ? String(update.providerStatusCode) : null,
      isFailure ? update.description : null,
      update.msg91RequestId,
    ],
  );
  return result.affectedRows;
}

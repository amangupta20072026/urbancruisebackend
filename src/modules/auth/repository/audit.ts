/**
 * ==============================================================================
 * auth.repository — audit (otp_events + login_events) and DLR
 * ==============================================================================
 * INSERTs:
 *   insertOtpEvent    — one row per OTP touchpoint (request/send/verify/etc)
 *   insertLoginEvent  — one row per successful/failed login
 *
 * UPDATE:
 *   applyDlr — idempotent one-shot transition of otp_events.delivery_status
 *              from 'pending' to a terminal state, driven by MSG91's DLR.
 *              Never downgrades a row already in a terminal state.
 * ==============================================================================
 */
import type { ResultSetHeader } from 'mysql2/promise';
import { pool } from '../../../shared/db/pool.js';
import type { DeviceMeta } from '../types.js';
import type { UserRole } from '../../../shared/rbac/roles.js';

/* ==============================================================================
 * otp_events
 * ============================================================================== */

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
  /**
   * Delivery channel for this audit row.
   *   - 'sms'  — real MSG91 send
   *   - 'test' — test-mobile bypass (no MSG91 call)
   * When email OTP lands, widen to include 'email'.
   *
   * Historical rows may hold 'whatsapp' or 'voice' (legacy). New writes
   * never produce those values, but the DB column may still contain them.
   */
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
  // NOTE: `fallback_from_channel` remains a column on `otp_events` for
  // historical rows written before the SMS-only migration. New writes
  // always bind NULL for it — the WhatsApp→SMS fallback concept is gone.
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
      null, // fallback_from_channel — always NULL post SMS-only migration
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

/* ==============================================================================
 * login_events
 * ============================================================================== */

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

/* ==============================================================================
 * DLR — delivery-status updates from MSG91 webhook
 *
 * Design: idempotent one-shot transition from 'pending' → terminal state.
 * We only ever move a row OUT of 'pending' — once a row has a terminal
 * delivery_status ('delivered'|'failed'|'rejected'|'user_blocked'), we never
 * downgrade it, even if a duplicate/late DLR arrives.
 *
 * Correlation key: msg91_request_id, populated by the send path when MSG91
 * accepted the SMS (see auth service). A single MSG91 request can map to
 * multiple otp_events rows only if you re-audit — in practice it's 1:1.
 * ============================================================================== */

/**
 * Bucket MSG91's DLR into the delivery_status enum used by otp_events.
 * Kept in the repository (not the provider adapter) because it is a schema
 * concern — the enum lives in the DB.
 */
function dlrToDeliveryStatus(
  dlr: 'delivered' | 'failed' | 'rejected',
  description: string | null,
): 'delivered' | 'failed' | 'undeliverable' | 'user_blocked' {
  if (dlr === 'delivered') return 'delivered';
  if (dlr === 'rejected') {
    // DND rejections are the recipient blocking us. Anything else rejected
    // is a template / DLT / permanent policy issue — treat as undeliverable.
    if (description && /dnd|blocked/i.test(description)) return 'user_blocked';
    return 'undeliverable';
  }
  // 'failed' — carrier-reported failure. Distinguish permanent from
  // transient by MSG91's own free-text description.
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
 * Apply one DLR to its otp_events row. Returns the number of rows updated
 * (0 or 1 — 0 means either the msg91_request_id is unknown, or the row is
 * already in a terminal state and we correctly refused to downgrade).
 *
 * Idempotency: the WHERE clause pins to delivery_status = 'pending', so
 * re-delivering the same DLR is a no-op. Safe to retry.
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

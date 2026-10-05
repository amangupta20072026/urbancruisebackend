/**
 * ==============================================================================
 * auth.repository — mobile_registry
 * ==============================================================================
 * Persistent per-mobile flags used across OTP flows:
 *   - verify_failure_count / verify_locked_until — brute-force protection
 *   - captcha_required_until                     — hCaptcha gate window
 *   - admin_blocked / admin_blocked_reason       — manual block
 *
 * All queries are parameterised via `?` placeholders.
 * ==============================================================================
 */
import type { RowDataPacket } from 'mysql2/promise';
import { pool } from '../../../shared/db/pool.js';

export type MobileFlags = {
  mobile: string;
  verify_failure_count: number;
  verify_locked_until: Date | null;
  captcha_required_until: Date | null;
  admin_blocked: 0 | 1;
  admin_blocked_reason: string | null;
};

export async function getMobileFlags(mobile: string): Promise<MobileFlags | null> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT mobile, verify_failure_count,
            verify_locked_until, captcha_required_until,
            admin_blocked, admin_blocked_reason
       FROM mobile_registry
      WHERE mobile = ?`,
    [mobile],
  );
  return rows.length ? (rows[0] as unknown as MobileFlags) : null;
}

export async function touchMobileRegistry(mobile: string): Promise<void> {
  await pool.execute(
    `INSERT INTO mobile_registry (mobile) VALUES (?)
     ON DUPLICATE KEY UPDATE last_seen_at = CURRENT_TIMESTAMP`,
    [mobile],
  );
}

export async function incrementVerifyFailure(mobile: string): Promise<number> {
  await pool.execute(
    `INSERT INTO mobile_registry (mobile, verify_failure_count) VALUES (?, 1)
     ON DUPLICATE KEY UPDATE verify_failure_count = verify_failure_count + 1`,
    [mobile],
  );
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT verify_failure_count FROM mobile_registry WHERE mobile = ?`,
    [mobile],
  );
  return rows.length ? Number(rows[0]!['verify_failure_count']) : 0;
}

export async function lockMobile(mobile: string, until: Date, captchaUntil: Date): Promise<void> {
  await pool.execute(
    `INSERT INTO mobile_registry (mobile, verify_locked_until, captcha_required_until)
         VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE
       verify_failure_count   = 0,
       verify_locked_until    = VALUES(verify_locked_until),
       captcha_required_until = VALUES(captcha_required_until)`,
    [mobile, until, captchaUntil],
  );
}

export async function resetVerifyFailure(mobile: string): Promise<void> {
  await pool.execute(
    `UPDATE mobile_registry
        SET verify_failure_count = 0,
            verify_locked_until  = NULL
      WHERE mobile = ?`,
    [mobile],
  );
}

/**
 * Is the phone stored on an account row admin-blocked in mobile_registry?
 *
 * Used by the per-role `get*StatusById` functions so that an admin block
 * takes effect on EXISTING sessions (at the next refresh or /auth/me), not
 * only at the next login (audit fix #6). Before this, `customers` and
 * `drivers` — which have no status column — were always reported 'active',
 * so a blocked customer kept refreshing tokens for the full 30-day TTL.
 *
 * `rawPhone` is the value as stored in the entity table, in any of the legacy
 * formats ('+91 98123 45678', '919812345678', '9812345678', …). It is reduced
 * to the canonical mobile_registry key ('91' + 10 digits) — the same form
 * normalizeMobile() produces at login. Unparseable values are not blocked.
 */
export async function isRawPhoneAdminBlocked(rawPhone: string | null): Promise<boolean> {
  const last10 = (rawPhone ?? '').replace(/\D/g, '').slice(-10);
  if (!/^[6-9]\d{9}$/.test(last10)) return false;
  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT admin_blocked FROM mobile_registry WHERE mobile = ? LIMIT 1',
    [`91${last10}`],
  );
  return rows.length > 0 && Number(rows[0]!['admin_blocked']) === 1;
}

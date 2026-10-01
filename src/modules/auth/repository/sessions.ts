/**
 * ==============================================================================
 * auth.repository — auth_sessions
 * ==============================================================================
 * Refresh-token session rows: create, look up, revoke, rotate.
 *
 * `rotateSession` runs in one DB transaction so we never end up with two
 * concurrently-active sessions or a hole where neither is active.
 * ==============================================================================
 */
import type { RowDataPacket, PoolConnection } from 'mysql2/promise';
import { pool } from '../../../shared/db/pool.js';
import { withTransaction } from '../../../shared/db/transaction.js';
import type { AuthSessionRow, DeviceMeta } from '../types.js';
import type { UserRole, SubRole } from '../../../shared/rbac/roles.js';

export type CreateSessionInput = {
  jti: string;
  role: UserRole;
  entityId: string;
  subRole: SubRole;
  refreshTokenHash: string;
  previousJti: string | null;
  device: DeviceMeta;
  ip: string | null;
  userAgent: string | null;
  expiresAt: Date;
};

export async function createSession(
  input: CreateSessionInput,
  conn?: PoolConnection,
): Promise<void> {
  const runner = conn ?? pool;
  await runner.execute(
    `INSERT INTO auth_sessions
       (jti, role, entity_id, sub_role, refresh_token_hash, previous_jti,
        device_id, device_name, platform, app_version, ip, user_agent,
        issued_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, INET6_ATON(?), ?, NOW(), ?)`,
    [
      input.jti,
      input.role,
      input.entityId,
      input.subRole,
      input.refreshTokenHash,
      input.previousJti,
      input.device.id,
      input.device.name,
      input.device.platform,
      input.device.appVersion,
      input.ip,
      input.userAgent,
      input.expiresAt,
    ],
  );
}

export async function findSessionByJti(jti: string): Promise<AuthSessionRow | null> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT id, jti, role, entity_id, sub_role, refresh_token_hash, previous_jti,
            device_id, device_name, platform, app_version, ip, user_agent,
            issued_at, last_used_at, expires_at, revoked_at, revoked_reason
       FROM auth_sessions WHERE jti = ? LIMIT 1`,
    [jti],
  );
  return rows.length ? (rows[0] as unknown as AuthSessionRow) : null;
}

export async function markSessionRevoked(jti: string, reason: string): Promise<void> {
  await pool.execute(
    `UPDATE auth_sessions
        SET revoked_at = NOW(), revoked_reason = ?
      WHERE jti = ? AND revoked_at IS NULL`,
    [reason, jti],
  );
}

export async function revokeAllForEntity(
  role: UserRole,
  entityId: string,
  reason: string,
): Promise<string[]> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT jti FROM auth_sessions
      WHERE role = ? AND entity_id = ? AND revoked_at IS NULL`,
    [role, entityId],
  );
  await pool.execute(
    `UPDATE auth_sessions
        SET revoked_at = NOW(), revoked_reason = ?
      WHERE role = ? AND entity_id = ? AND revoked_at IS NULL`,
    [reason, role, entityId],
  );
  return rows.map(r => String(r['jti']));
}

/**
 * Rotation is one transaction:
 *   1. mark oldJti revoked (rotation)
 *   2. insert new session with previous_jti = oldJti
 * Both must succeed together — otherwise we risk two active sessions or none.
 */
export async function rotateSession(oldJti: string, next: CreateSessionInput): Promise<void> {
  await withTransaction(async conn => {
    await conn.execute(
      `UPDATE auth_sessions SET revoked_at = NOW(), revoked_reason = 'rotation'
        WHERE jti = ? AND revoked_at IS NULL`,
      [oldJti],
    );
    await createSession(next, conn);
  });
}

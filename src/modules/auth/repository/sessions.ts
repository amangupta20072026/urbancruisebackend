/** auth repository: auth_sessions (create, find, revoke, rotate). */
import type { RowDataPacket, PoolConnection, ResultSetHeader } from 'mysql2/promise';
import { pool } from '../../../shared/db/pool.js';
import { withTransaction } from '../../../shared/db/transaction.js';
import type { AuthSessionRow, SessionDevice } from '../types.js';
import type { UserRole } from '../../../shared/rbac/roles.js';

/** Must match the auth_sessions.revoked_reason ENUM exactly. */
export type RevokeReason =
  'logout' | 'rotation' | 'reuse_detected' | 'admin_force' | 'password_change' | 'all_devices';

export type CreateSessionInput = {
  jti: string;
  role: UserRole;
  entityId: string;
  refreshTokenHash: string;
  previousJti: string | null;
  /**
   * Login family: the jti of the login that started this chain. A login
   * passes its own jti; every refresh (rotation or grace sibling) inherits
   * the parent's. Logout of one device revokes the whole family.
   */
  familyId: string;
  /** Nullable on refresh (see SessionDevice); login always passes a full device. */
  device: SessionDevice;
  ip: string | null;
  userAgent: string | null;
  expiresAt: Date;
};

export async function createSession(
  input: CreateSessionInput,
  conn?: PoolConnection,
): Promise<void> {
  const runner = conn ?? pool;
  // sub_role is legacy; always NULL.
  await runner.execute(
    `INSERT INTO auth_sessions
       (jti, role, entity_id, sub_role, refresh_token_hash, previous_jti, family_id,
        device_id, device_name, platform, app_version, ip, user_agent,
        issued_at, expires_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, INET6_ATON(?), ?, NOW(), ?)`,
    [
      input.jti,
      input.role,
      input.entityId,
      input.refreshTokenHash,
      input.previousJti,
      input.familyId,
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
    `SELECT id, jti, role, entity_id, refresh_token_hash, previous_jti, family_id,
            device_id, device_name, platform, app_version, ip, user_agent,
            issued_at, last_used_at, expires_at, revoked_at, revoked_reason
       FROM auth_sessions WHERE jti = ? LIMIT 1`,
    [jti],
  );
  return rows.length ? (rows[0] as unknown as AuthSessionRow) : null;
}

export async function markSessionRevoked(jti: string, reason: RevokeReason): Promise<void> {
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
  reason: RevokeReason,
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
 * True if oldJti looks like a duplicate refresh, not theft: it was revoked by
 * rotation within graceSeconds (DB clock, so server drift doesn't matter)
 * and its replacement session is still active.
 */
export async function isWithinRotationGrace(
  oldJti: string,
  graceSeconds: number,
): Promise<boolean> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT 1
       FROM auth_sessions o
       JOIN auth_sessions s
         ON s.role = o.role
        AND s.entity_id = o.entity_id
        AND s.previous_jti = o.jti
      WHERE o.jti = ?
        AND o.revoked_reason = 'rotation'
        AND o.revoked_at >= NOW() - INTERVAL ? SECOND
        AND s.revoked_at IS NULL
      LIMIT 1`,
    [oldJti, graceSeconds],
  );
  return rows.length > 0;
}

/** Revokes oldJti and inserts its replacement in one transaction. */
export async function rotateSession(oldJti: string, next: CreateSessionInput): Promise<boolean> {
  return withTransaction(async conn => {
    // Only one concurrent refresh can revoke it; the other creates nothing,
    // so a session can't fork into two refresh chains.
    const [res] = await conn.execute<ResultSetHeader>(
      `UPDATE auth_sessions SET revoked_at = NOW(), revoked_reason = 'rotation'
        WHERE jti = ? AND revoked_at IS NULL`,
      [oldJti],
    );
    if (res.affectedRows !== 1) return false;
    await createSession(next, conn);
    return true;
  });
}

/** A session ended by revokeFamily: its jti, plus the device for push-token cleanup. */
export type RevokedSession = { jti: string; deviceId: string | null };

/**
 * Revokes every active session in one login family and returns them.
 *
 * Runs in a transaction with SELECT ... FOR UPDATE on (family_id, revoked_at),
 * so it serialises with createGraceSibling: a sibling is either committed
 * before this runs (and is revoked here) or sees the family already revoked
 * (and is never created).
 */
export async function revokeFamily(
  role: UserRole,
  entityId: string,
  familyId: string,
  reason: RevokeReason,
): Promise<RevokedSession[]> {
  return withTransaction(async conn => {
    const [rows] = await conn.execute<RowDataPacket[]>(
      `SELECT jti, device_id FROM auth_sessions
        WHERE family_id = ? AND role = ? AND entity_id = ? AND revoked_at IS NULL
        FOR UPDATE`,
      [familyId, role, entityId],
    );
    if (rows.length === 0) return [];
    await conn.execute(
      `UPDATE auth_sessions
          SET revoked_at = NOW(), revoked_reason = ?
        WHERE family_id = ? AND role = ? AND entity_id = ? AND revoked_at IS NULL`,
      [reason, familyId, role, entityId],
    );
    return rows.map(r => ({
      jti: String(r['jti']),
      deviceId: (r['device_id'] as string | null) ?? null,
    }));
  });
}

/**
 * Inserts a grace-window sibling only if its family still has an active
 * session. Locks the family's active rows first (see revokeFamily), so a
 * concurrent logout can never leave a freshly minted sibling behind.
 * Returns false if the family was already revoked.
 */
export async function createGraceSibling(next: CreateSessionInput): Promise<boolean> {
  return withTransaction(async conn => {
    const [rows] = await conn.execute<RowDataPacket[]>(
      `SELECT id FROM auth_sessions
        WHERE family_id = ? AND role = ? AND entity_id = ? AND revoked_at IS NULL
        FOR UPDATE`,
      [next.familyId, next.role, next.entityId],
    );
    if (rows.length === 0) return false;
    await createSession(next, conn);
    return true;
  });
}

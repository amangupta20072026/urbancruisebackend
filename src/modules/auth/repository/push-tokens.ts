/**
 * auth repository: deletes push tokens when a device or account is signed
 * out (logout, logout-all, forced revoke, refresh-token reuse), so it stops
 * receiving notifications. Notifications owns the table; auth only deletes.
 * A direct DELETE avoids importing the notifications module, which loads
 * Firebase on import.
 * Matching is by device_id, so the app must send the same id to
 * /auth/otp/verify and /notifications/tokens.
 */
import { pool } from '../../../shared/db/pool.js';
import type { UserRole } from '../../../shared/rbac/roles.js';

/** Deletes an account's tokens, scoped by (role, entity_id). deviceId null means all devices. */
export async function deletePushTokens(
  role: UserRole,
  entityId: string,
  deviceId: string | null,
): Promise<void> {
  if (deviceId === null) {
    await pool.execute('DELETE FROM push_tokens WHERE role = ? AND entity_id = ?', [
      role,
      entityId,
    ]);
    return;
  }
  await pool.execute('DELETE FROM push_tokens WHERE role = ? AND entity_id = ? AND device_id = ?', [
    role,
    entityId,
    deviceId,
  ]);
}
